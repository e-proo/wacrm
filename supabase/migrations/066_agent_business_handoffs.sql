-- ============================================================
-- 066_agent_business_handoffs.sql
-- Durable customer -> customer-agent -> admin-agent -> approval ->
-- canonical-data handoff linkage.
-- ============================================================

-- Preserve the exact inbound source of every intent. This lets the runtime
-- build replay-safe idempotency keys from a message UUID instead of collapsing
-- every later request with the same free-text service hint.
alter table public.customer_intents
  add column if not exists source_message_id uuid references public.messages(id) on delete set null;

create index if not exists customer_intents_source_message_idx
  on public.customer_intents(account_id, source_message_id)
  where source_message_id is not null;

-- Request creation must be replay-safe in the same way migration 065 made
-- coverage offers replay-safe.
alter table public.coverage_requests
  add column if not exists source_change_request_id uuid references public.change_requests(id) on delete set null;

create unique index if not exists coverage_requests_source_change_request_uidx
  on public.coverage_requests(source_change_request_id)
  where source_change_request_id is not null;

-- Customer-facing result delivery is durable. A later worker/sender can claim
-- these rows without re-running the business mutation itself.
create table if not exists public.customer_intent_notifications (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  intent_id uuid not null references public.customer_intents(id) on delete cascade,
  change_request_id uuid references public.change_requests(id) on delete set null,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  event_type text not null check (event_type in (
    'approved_and_applied', 'rejected', 'needs_clarification', 'matched'
  )),
  message_text text not null check (char_length(message_text) between 1 and 2000),
  status text not null default 'pending' check (status in (
    'pending', 'sending', 'sent', 'requires_reconciliation', 'failed'
  )),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  claim_token uuid,
  claimed_at timestamptz,
  local_message_id uuid references public.messages(id) on delete set null,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create unique index if not exists customer_intent_notifications_once_uidx
  on public.customer_intent_notifications(
    account_id, intent_id, change_request_id, event_type
  );

create index if not exists customer_intent_notifications_queue_idx
  on public.customer_intent_notifications(status, available_at, created_at);

alter table public.customer_intent_notifications enable row level security;

drop policy if exists customer_intent_notifications_select on public.customer_intent_notifications;
create policy customer_intent_notifications_select
  on public.customer_intent_notifications for select
  using (is_account_member(account_id, 'admin'));

-- No client insert/update/delete policies. Service-role runtime owns delivery.

-- Reserve a generic outbound business event before a Meta call. This provides
-- the same "one local message row first" safety boundary used by AI run sends.
alter table public.messages
  add column if not exists engine_idempotency_key text;

create unique index if not exists messages_engine_idempotency_uidx
  on public.messages(engine_idempotency_key)
  where engine_idempotency_key is not null;

-- Existing revisions that already grant coverage.propose_offer must move to
-- v2 because identity fields are no longer model-controlled; they are injected
-- from runtime context. This is a security-compatible schema upgrade.
update public.ai_agent_tool_grants
   set tool_version = 2
 where tool_key = 'coverage.propose_offer'
   and tool_version = 1;

-- Seed the new request/admin-read tools only into template suggestions. This
-- does NOT silently grant them to already-published revisions.
update public.ai_agent_templates
   set suggested_tool_keys = suggested_tool_keys
       || '["coverage.propose_request"]'::jsonb
 where system_template_key in ('customer_service', 'coverage')
   and not (suggested_tool_keys ? 'coverage.propose_request');

update public.ai_agent_templates
   set suggested_tool_keys = suggested_tool_keys || '["coverage.admin_list_offers"]'::jsonb
 where system_template_key = 'admin_services'
   and not (suggested_tool_keys ? 'coverage.admin_list_offers');

update public.ai_agent_templates
   set suggested_tool_keys = suggested_tool_keys || '["coverage.admin_list_requests"]'::jsonb
 where system_template_key = 'admin_services'
   and not (suggested_tool_keys ? 'coverage.admin_list_requests');

update public.ai_agent_templates
   set suggested_tool_keys = suggested_tool_keys || '["change_requests.list_pending"]'::jsonb
 where system_template_key = 'admin_services'
   and not (suggested_tool_keys ? 'change_requests.list_pending');

-- Customer agents may read published rates and register buy/sell requests, but
-- never propose or execute rate-book changes.
update public.ai_agent_templates
   set suggested_tool_keys = suggested_tool_keys || '["exchange_rates.record_trade_request"]'::jsonb
 where system_template_key in ('customer_service', 'services_pricing')
   and not (suggested_tool_keys ? 'exchange_rates.record_trade_request');


-- ------------------------------------------------------------
-- Admin-agent exchange-rate mutations are revisioned and replay-safe.
-- The approved CR is the authority; the model never writes a live rate row.
-- ------------------------------------------------------------
alter table public.exchange_rate_book_versions
  add column if not exists source_change_request_id uuid references public.change_requests(id) on delete set null;

create unique index if not exists exchange_rate_versions_source_change_uidx
  on public.exchange_rate_book_versions(source_change_request_id)
  where source_change_request_id is not null;

create or replace function public.apply_exchange_rate_pair_change(
  p_account_id uuid,
  p_change_request_id uuid,
  p_book_id uuid,
  p_expected_current_version_id uuid,
  p_base_currency text,
  p_quote_currency text,
  p_buy_rate numeric,
  p_sell_rate numeric,
  p_rate_unit numeric,
  p_notes_public text,
  p_actor_user_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_book public.exchange_rate_books%rowtype;
  v_existing uuid;
  v_new_version uuid;
  v_next integer;
  v_base text := upper(trim(p_base_currency));
  v_quote text := upper(trim(p_quote_currency));
begin
  -- Only an approved CR that has already been claimed by the deterministic
  -- executor may invoke this mutation path.
  if not exists (
    select 1 from public.change_requests cr
     where cr.id = p_change_request_id
       and cr.account_id = p_account_id
       and cr.target_type = 'rate_book_version'
       and cr.intent = 'create'
       and cr.status = 'executing'
  ) then
    raise exception 'CHANGE_REQUEST_NOT_EXECUTING' using errcode = 'P0001';
  end if;

  select id into v_existing
    from public.exchange_rate_book_versions
   where source_change_request_id = p_change_request_id;
  if v_existing is not null then
    return v_existing;
  end if;

  if v_base !~ '^[A-Z_]{3,8}$' or v_quote !~ '^[A-Z_]{3,8}$' or v_base = v_quote then
    raise exception 'INVALID_CURRENCY_PAIR' using errcode = '22023';
  end if;
  if p_buy_rate <= 0 or p_sell_rate <= 0 then
    raise exception 'INVALID_EXCHANGE_RATE' using errcode = '22023';
  end if;
  if p_rate_unit is not null and p_rate_unit <= 0 then
    raise exception 'INVALID_RATE_UNIT' using errcode = '22023';
  end if;

  select * into v_book
    from public.exchange_rate_books
   where id = p_book_id and account_id = p_account_id
   for update;
  if not found then raise exception 'EXCHANGE_BOOK_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_book.status <> 'active' then raise exception 'EXCHANGE_BOOK_NOT_ACTIVE' using errcode = 'P0001'; end if;
  if v_book.current_published_version_id is distinct from p_expected_current_version_id then
    raise exception 'EXCHANGE_CURRENT_VERSION_CHANGED' using errcode = '40001';
  end if;

  select coalesce(max(version_number), 0) + 1 into v_next
    from public.exchange_rate_book_versions
   where book_id = p_book_id;

  insert into public.exchange_rate_book_versions (
    account_id, book_id, version_number, status, effective_at, source,
    created_by, source_change_request_id
  ) values (
    p_account_id, p_book_id, v_next, 'draft', now(), 'admin_agent',
    p_actor_user_id, p_change_request_id
  ) returning id into v_new_version;

  if v_book.current_published_version_id is not null then
    insert into public.exchange_rates (
      account_id, version_id, base_currency, quote_currency,
      buy_rate, sell_rate, min_amount, max_amount, rate_unit,
      notes_public, notes_internal
    )
    select account_id, v_new_version, base_currency, quote_currency,
           buy_rate, sell_rate, min_amount, max_amount, rate_unit,
           notes_public, notes_internal
      from public.exchange_rates
     where account_id = p_account_id
       and version_id = v_book.current_published_version_id;
  end if;

  -- A pair update replaces all buckets for that pair. This matches the
  -- current publish validator, which deliberately permits one row per pair.
  delete from public.exchange_rates
   where account_id = p_account_id
     and version_id = v_new_version
     and base_currency = v_base
     and quote_currency = v_quote;

  insert into public.exchange_rates (
    account_id, version_id, base_currency, quote_currency,
    buy_rate, sell_rate, rate_unit, notes_public
  ) values (
    p_account_id, v_new_version, v_base, v_quote,
    p_buy_rate, p_sell_rate, p_rate_unit, nullif(trim(coalesce(p_notes_public, '')), '')
  );

  perform public.publish_exchange_rate_version(p_book_id, v_new_version, p_actor_user_id);
  return v_new_version;
end;
$$;

revoke all on function public.apply_exchange_rate_pair_change(
  uuid, uuid, uuid, uuid, text, text, numeric, numeric, numeric, text, uuid
) from public;
grant execute on function public.apply_exchange_rate_pair_change(
  uuid, uuid, uuid, uuid, text, text, numeric, numeric, numeric, text, uuid
) to service_role;

-- Admin system template: surface the operational read + proposal tools without
-- auto-granting them to any published revision.
update public.ai_agent_templates
   set suggested_tool_keys = suggested_tool_keys || '["exchange_rates.propose_pair_change"]'::jsonb
 where system_template_key = 'admin_services'
   and not (suggested_tool_keys ? 'exchange_rates.propose_pair_change');

update public.ai_agent_templates
   set suggested_tool_keys = suggested_tool_keys || '["intents.propose_decision"]'::jsonb
 where system_template_key = 'admin_services'
   and not (suggested_tool_keys ? 'intents.propose_decision');

-- ------------------------------------------------------------
-- Approved admin-agent service edits become a NEW published revision.
-- Internal notes are preserved from the old revision and are never supplied
-- by the model. Optimistic version + current-revision checks prevent stale
-- approvals from overwriting newer human edits.
-- ------------------------------------------------------------
alter table public.service_revisions
  add column if not exists source_change_request_id uuid references public.change_requests(id) on delete set null;

create unique index if not exists service_revisions_source_change_uidx
  on public.service_revisions(source_change_request_id)
  where source_change_request_id is not null;

create or replace function public.apply_service_agent_change(
  p_account_id uuid,
  p_change_request_id uuid,
  p_service_id uuid,
  p_expected_version bigint,
  p_expected_current_revision_id uuid,
  p_name text,
  p_public_description text,
  p_ai_guidance text,
  p_field_values jsonb,
  p_pricing_rule_id uuid,
  p_service_status text,
  p_actor_user_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service public.services%rowtype;
  v_current public.service_revisions%rowtype;
  v_existing uuid;
  v_new_revision uuid;
  v_next integer;
begin
  if not exists (
    select 1 from public.change_requests cr
     where cr.id = p_change_request_id
       and cr.account_id = p_account_id
       and cr.target_type = 'service'
       and cr.target_id = p_service_id
       and cr.intent = 'update'
       and cr.status = 'executing'
  ) then
    raise exception 'CHANGE_REQUEST_NOT_EXECUTING' using errcode = 'P0001';
  end if;

  select id into v_existing
    from public.service_revisions
   where source_change_request_id = p_change_request_id;
  if v_existing is not null then return v_existing; end if;

  select * into v_service
    from public.services
   where id = p_service_id and account_id = p_account_id
   for update;
  if not found then raise exception 'SERVICE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_service.version <> p_expected_version then
    raise exception 'SERVICE_VERSION_CHANGED' using errcode = '40001';
  end if;
  if v_service.current_revision_id is distinct from p_expected_current_revision_id then
    raise exception 'SERVICE_CURRENT_REVISION_CHANGED' using errcode = '40001';
  end if;
  if p_service_status not in ('draft','active','paused','archived') then
    raise exception 'SERVICE_STATUS_INVALID' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'SERVICE_NAME_REQUIRED' using errcode = '22023';
  end if;

  if v_service.current_revision_id is null then
    raise exception 'SERVICE_CURRENT_REVISION_REQUIRED' using errcode = 'P0001';
  end if;
  select * into v_current
    from public.service_revisions
   where id = v_service.current_revision_id
     and account_id = p_account_id
     and service_id = p_service_id
   for update;
  if not found then raise exception 'SERVICE_CURRENT_REVISION_NOT_FOUND' using errcode = 'P0002'; end if;

  if p_pricing_rule_id is not null and not exists (
    select 1 from public.service_pricing_rules pr
     where pr.id = p_pricing_rule_id
       and pr.account_id = p_account_id
       and pr.status = 'published'
  ) then
    raise exception 'PRICING_RULE_NOT_PUBLISHED' using errcode = 'P0001';
  end if;

  select coalesce(max(revision_number), 0) + 1 into v_next
    from public.service_revisions where service_id = p_service_id;

  update public.service_revisions
     set status = 'superseded'
   where id = v_current.id and status = 'published';

  insert into public.service_revisions (
    account_id, service_id, revision_number, category_schema_version_id,
    name, public_description, ai_guidance, internal_notes, field_values,
    pricing_rule_id, valid_from, valid_until, status,
    created_by, published_by, published_at, source_change_request_id
  ) values (
    p_account_id, p_service_id, v_next, v_current.category_schema_version_id,
    trim(p_name), p_public_description, p_ai_guidance,
    v_current.internal_notes, coalesce(p_field_values, '{}'::jsonb),
    p_pricing_rule_id, v_current.valid_from, v_current.valid_until, 'published',
    p_actor_user_id, p_actor_user_id, now(), p_change_request_id
  ) returning id into v_new_revision;

  update public.services
     set name = trim(p_name),
         status = p_service_status,
         current_revision_id = v_new_revision,
         version = version + 1,
         updated_by = p_actor_user_id
   where id = p_service_id and account_id = p_account_id;

  perform public.append_service_activity_event(
    p_account_id, 'service_revision', v_new_revision,
    'service.revision.published_by_admin_agent', 'user',
    coalesce(p_actor_user_id::text, ''),
    jsonb_build_object('service_id', p_service_id, 'change_request_id', p_change_request_id)
  );
  return v_new_revision;
end;
$$;

revoke all on function public.apply_service_agent_change(
  uuid, uuid, uuid, bigint, uuid, text, text, text, jsonb, uuid, text, uuid
) from public;
grant execute on function public.apply_service_agent_change(
  uuid, uuid, uuid, bigint, uuid, text, text, text, jsonb, uuid, text, uuid
) to service_role;

update public.ai_agent_templates
   set suggested_tool_keys = suggested_tool_keys || '["services.propose_update"]'::jsonb
 where system_template_key = 'admin_services'
   and not (suggested_tool_keys ? 'services.propose_update');

-- ------------------------------------------------------------
-- Admin-agent service price changes: create a new immutable pricing rule and
-- attach it through a new published service revision in ONE transaction.
-- Existing published pricing rules are left untouched because they may be
-- shared by other services.
-- ------------------------------------------------------------
alter table public.service_pricing_rules
  add column if not exists source_change_request_id uuid references public.change_requests(id) on delete set null;

create unique index if not exists service_pricing_rules_source_change_uidx
  on public.service_pricing_rules(source_change_request_id)
  where source_change_request_id is not null;

create or replace function public.apply_service_pricing_change(
  p_account_id uuid,
  p_change_request_id uuid,
  p_service_id uuid,
  p_expected_service_version bigint,
  p_expected_current_revision_id uuid,
  p_name text,
  p_kind text,
  p_fee_currency text,
  p_input_currency text,
  p_minimum_fee numeric,
  p_maximum_fee numeric,
  p_rounding_mode text,
  p_formula_config jsonb,
  p_actor_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service public.services%rowtype;
  v_current public.service_revisions%rowtype;
  v_rule_id uuid;
  v_revision_id uuid;
  v_next integer;
begin
  if not exists (
    select 1 from public.change_requests cr
     where cr.id = p_change_request_id
       and cr.account_id = p_account_id
       and cr.target_type = 'pricing_rule'
       and cr.target_id is null
       and cr.intent = 'create_and_attach'
       and cr.status = 'executing'
  ) then
    raise exception 'CHANGE_REQUEST_NOT_EXECUTING' using errcode = 'P0001';
  end if;

  select id into v_rule_id
    from public.service_pricing_rules
   where source_change_request_id = p_change_request_id;
  if v_rule_id is not null then
    select sr.id into v_revision_id
      from public.service_revisions sr
     where sr.account_id = p_account_id
       and sr.service_id = p_service_id
       and sr.pricing_rule_id = v_rule_id
     order by sr.revision_number desc
     limit 1;
    return jsonb_build_object('pricing_rule_id', v_rule_id, 'revision_id', v_revision_id, 'idempotent', true);
  end if;

  if p_kind not in ('fixed','percentage','per_unit','fixed_plus_percentage','tiered','fx_buy_sell','manual_quote') then
    raise exception 'PRICING_KIND_INVALID' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'PRICING_NAME_REQUIRED' using errcode = '22023';
  end if;
  if p_minimum_fee is not null and p_minimum_fee < 0 then
    raise exception 'PRICING_MINIMUM_INVALID' using errcode = '22023';
  end if;
  if p_maximum_fee is not null and p_maximum_fee < 0 then
    raise exception 'PRICING_MAXIMUM_INVALID' using errcode = '22023';
  end if;
  if p_minimum_fee is not null and p_maximum_fee is not null and p_minimum_fee > p_maximum_fee then
    raise exception 'PRICING_RANGE_INVALID' using errcode = '22023';
  end if;

  select * into v_service
    from public.services
   where id = p_service_id and account_id = p_account_id
   for update;
  if not found then raise exception 'SERVICE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_service.version <> p_expected_service_version then
    raise exception 'SERVICE_VERSION_CHANGED' using errcode = '40001';
  end if;
  if v_service.current_revision_id is distinct from p_expected_current_revision_id then
    raise exception 'SERVICE_CURRENT_REVISION_CHANGED' using errcode = '40001';
  end if;

  select * into v_current
    from public.service_revisions
   where id = p_expected_current_revision_id
     and account_id = p_account_id
     and service_id = p_service_id
   for update;
  if not found then raise exception 'SERVICE_CURRENT_REVISION_NOT_FOUND' using errcode = 'P0002'; end if;

  insert into public.service_pricing_rules (
    account_id, name, kind, fee_currency, input_currency,
    minimum_fee, maximum_fee, rounding_mode, formula_config,
    tax_policy, status, created_by, published_by, published_at,
    source_change_request_id
  ) values (
    p_account_id, trim(p_name), p_kind, nullif(trim(p_fee_currency), ''), nullif(trim(p_input_currency), ''),
    p_minimum_fee, p_maximum_fee, p_rounding_mode, coalesce(p_formula_config, '{}'::jsonb),
    'none', 'published', p_actor_user_id, p_actor_user_id, now(),
    p_change_request_id
  ) returning id into v_rule_id;

  select coalesce(max(revision_number), 0) + 1 into v_next
    from public.service_revisions where service_id = p_service_id;

  update public.service_revisions
     set status = 'superseded'
   where id = v_current.id and status = 'published';

  insert into public.service_revisions (
    account_id, service_id, revision_number, category_schema_version_id,
    name, public_description, ai_guidance, internal_notes, field_values,
    pricing_rule_id, valid_from, valid_until, status,
    created_by, published_by, published_at
  ) values (
    p_account_id, p_service_id, v_next, v_current.category_schema_version_id,
    v_current.name, v_current.public_description, v_current.ai_guidance,
    v_current.internal_notes, v_current.field_values,
    v_rule_id, v_current.valid_from, v_current.valid_until, 'published',
    p_actor_user_id, p_actor_user_id, now()
  ) returning id into v_revision_id;

  update public.services
     set current_revision_id = v_revision_id,
         version = version + 1,
         updated_by = p_actor_user_id
   where id = p_service_id and account_id = p_account_id;

  perform public.append_service_activity_event(
    p_account_id, 'pricing_rule', v_rule_id,
    'pricing_rule.published_by_admin_agent', 'user',
    coalesce(p_actor_user_id::text, ''),
    jsonb_build_object('service_id', p_service_id, 'change_request_id', p_change_request_id)
  );
  perform public.append_service_activity_event(
    p_account_id, 'service_revision', v_revision_id,
    'service.pricing_changed_by_admin_agent', 'user',
    coalesce(p_actor_user_id::text, ''),
    jsonb_build_object('service_id', p_service_id, 'pricing_rule_id', v_rule_id, 'change_request_id', p_change_request_id)
  );

  return jsonb_build_object('pricing_rule_id', v_rule_id, 'revision_id', v_revision_id, 'idempotent', false);
end;
$$;

revoke all on function public.apply_service_pricing_change(
  uuid, uuid, uuid, bigint, uuid, text, text, text, text, numeric, numeric, text, jsonb, uuid
) from public;
grant execute on function public.apply_service_pricing_change(
  uuid, uuid, uuid, bigint, uuid, text, text, text, text, numeric, numeric, text, jsonb, uuid
) to service_role;

-- Service-price mutations are administration-only. Remove the proposal tool
-- from every customer-purpose system template even if an earlier draft of this
-- migration added it, then suggest it only for the trusted admin template.
update public.ai_agent_templates
   set suggested_tool_keys = suggested_tool_keys - 'pricing_rules.propose_service_price'
 where system_template_key <> 'admin_services'
   and suggested_tool_keys ? 'pricing_rules.propose_service_price';

update public.ai_agent_templates
   set suggested_tool_keys = suggested_tool_keys || '["pricing_rules.propose_service_price"]'::jsonb
 where system_template_key = 'admin_services'
   and not (suggested_tool_keys ? 'pricing_rules.propose_service_price');

-- ------------------------------------------------------------
-- Human-admin visibility for customer -> admin handoffs.
-- Forwarded customer intents (including FX buy/sell requests) create a
-- dashboard notification for account owners/admins. The admin AI itself reads
-- the same durable intent queue through intents.search; no model-to-model free
-- text channel is introduced.
-- ------------------------------------------------------------
alter table public.notifications
  drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check check (
    type in ('conversation_assigned', 'customer_intent_forwarded')
  );

create or replace function public.notify_customer_intent_forwarded()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact_label text;
  v_profile record;
begin
  if new.status <> 'forwarded_to_admin' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;

  select coalesce(nullif(c.name, ''), c.phone, 'Customer')
    into v_contact_label
    from public.contacts c
   where c.id = new.contact_id
     and c.account_id = new.account_id;

  for v_profile in
    select p.user_id
      from public.profiles p
     where p.account_id = new.account_id
       and p.account_role in ('owner', 'admin')
  loop
    insert into public.notifications (
      account_id, user_id, type, conversation_id, contact_id,
      actor_user_id, title, body
    ) values (
      new.account_id,
      v_profile.user_id,
      'customer_intent_forwarded',
      new.conversation_id,
      new.contact_id,
      null,
      'Customer request needs review',
      coalesce(v_contact_label, 'Customer') || ': ' || left(new.service_hint, 240)
    );
  end loop;

  return new;
exception when others then
  -- Handoff persistence is authoritative; a dashboard notification must never
  -- make the customer request fail.
  raise warning 'Failed to notify admins for customer intent %: %', new.id, sqlerrm;
  return new;
end;
$$;

alter function public.notify_customer_intent_forwarded() owner to postgres;

drop trigger if exists on_customer_intent_forwarded on public.customer_intents;
create trigger on_customer_intent_forwarded
  after insert or update of status on public.customer_intents
  for each row execute function public.notify_customer_intent_forwarded();

-- Admin agent must be able to inspect the same queue the dashboard shows.
update public.ai_agent_templates
   set suggested_tool_keys = suggested_tool_keys || '["intents.search"]'::jsonb
 where system_template_key = 'admin_services'
   and not (suggested_tool_keys ? 'intents.search');

-- A general customer-service agent is allowed to quote CURRENT published
-- rates and register a buy/sell request. It is never given rate mutation tools.
update public.ai_agent_templates
   set suggested_tool_keys = suggested_tool_keys || '["exchange_rates.get_current"]'::jsonb
 where system_template_key = 'customer_service'
   and not (suggested_tool_keys ? 'exchange_rates.get_current');
