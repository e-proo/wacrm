-- ============================================================
-- 097_fx_business_event_controlled_cutover.sql
-- Prepare a reversible, account-scoped FX cutover to the general business
-- event outbox. Nothing is activated by this migration.
--
-- Safety model:
--   * missing route row => legacy remains authoritative
--   * activation requires durable matched-legacy evidence for all canonical
--     FX customer lifecycle events
--   * activation never promotes historical shadow rows
--   * while active, the legacy claim skips FX rows
--   * new FX events become active at creation time only
--   * rollback is blocked while a new-path send is in-flight/reconciliation
--   * legacy_notification_id preserves the historical engine idempotency key
-- ============================================================

create table if not exists public.business_event_delivery_controls (
  account_id uuid not null references public.accounts(id) on delete cascade,
  route_key text not null
    check (route_key ~ '^[a-z][a-z0-9_]{2,100}$'),
  mode text not null default 'legacy'
    check (mode in ('legacy', 'active')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, route_key)
);

alter table public.business_event_delivery_controls enable row level security;

revoke all on table public.business_event_delivery_controls
  from public, anon, authenticated, service_role;

grant select, insert, update, delete
  on table public.business_event_delivery_controls
  to service_role;

drop policy if exists business_event_delivery_controls_service_role_all
  on public.business_event_delivery_controls;

create policy business_event_delivery_controls_service_role_all
  on public.business_event_delivery_controls
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.business_event_delivery_controls is
  'Account-scoped delivery route controls. Missing rows intentionally mean legacy delivery; activation must be explicit.';

-- ------------------------------------------------------------
-- Read-only FX readiness contract.
-- ------------------------------------------------------------
create or replace function public.inspect_fx_business_event_cutover_readiness(
  p_account_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_mode text;
  v_matched_event_types integer;
  v_evidence_rows integer;
  v_blockers integer;
  v_legacy_nonterminal integer;
  v_active_nonterminal integer;
  v_ready boolean;
begin
  select coalesce(
    (
      select c.mode
      from public.business_event_delivery_controls as c
      where c.account_id = p_account_id
        and c.route_key = 'fx_trade_customer_whatsapp'
    ),
    'legacy'
  ) into v_mode;

  select
    count(*)::integer,
    count(distinct beo.event_type)::integer
  into v_evidence_rows, v_matched_event_types
  from public.business_event_outbox as beo
  where beo.account_id = p_account_id
    and beo.delivery_mode = 'shadow'
    and beo.subject_type = 'fx_trade_request'
    and beo.audience = 'customer'
    and beo.channel = 'whatsapp'
    and beo.event_type = any(array[
      'exchange_rate.trade.requested',
      'exchange_rate.trade.approved',
      'exchange_rate.trade.rejected',
      'exchange_rate.trade.completed'
    ]::text[])
    and beo.shadow_projection_status = 'matched_legacy'
    and beo.legacy_notification_id is not null;

  select count(*)::integer
    into v_blockers
    from public.business_event_outbox as beo
   where beo.account_id = p_account_id
     and beo.delivery_mode = 'shadow'
     and beo.subject_type = 'fx_trade_request'
     and beo.audience = 'customer'
     and beo.channel = 'whatsapp'
     and beo.event_type = any(array[
       'exchange_rate.trade.requested',
       'exchange_rate.trade.approved',
       'exchange_rate.trade.rejected',
       'exchange_rate.trade.completed'
     ]::text[])
     and (
       beo.shadow_projection_status <> 'matched_legacy'
       or beo.legacy_notification_id is null
     );

  select count(*)::integer
    into v_legacy_nonterminal
    from public.customer_intent_notifications as cin
   where cin.account_id = p_account_id
     and cin.fx_trade_request_id is not null
     and cin.status in ('pending', 'sending', 'requires_reconciliation');

  select count(*)::integer
    into v_active_nonterminal
    from public.business_event_outbox as beo
   where beo.account_id = p_account_id
     and beo.delivery_mode = 'active'
     and beo.subject_type = 'fx_trade_request'
     and beo.event_type = any(array[
       'exchange_rate.trade.requested',
       'exchange_rate.trade.approved',
       'exchange_rate.trade.rejected',
       'exchange_rate.trade.completed'
     ]::text[])
     and beo.status in (
       'pending',
       'sending',
       'failed',
       'requires_reconciliation'
     );

  v_ready :=
    v_matched_event_types = 4
    and v_blockers = 0
    and v_legacy_nonterminal = 0
    and v_active_nonterminal = 0;

  return jsonb_build_object(
    'route_key', 'fx_trade_customer_whatsapp',
    'mode', v_mode,
    'ready', v_ready,
    'required_event_types', 4,
    'matched_event_types', v_matched_event_types,
    'evidence_rows', v_evidence_rows,
    'blockers', v_blockers,
    'legacy_nonterminal', v_legacy_nonterminal,
    'active_nonterminal', v_active_nonterminal
  );
end;
$$;

revoke execute on function public.inspect_fx_business_event_cutover_readiness(uuid)
  from public, anon, authenticated;

grant execute on function public.inspect_fx_business_event_cutover_readiness(uuid)
  to service_role;

-- ------------------------------------------------------------
-- Explicit activation / rollback switch.
--
-- Activation changes routing for FUTURE FX events only. Historical shadow rows
-- remain shadow forever and are never promoted by this function.
-- ------------------------------------------------------------
create or replace function public.set_fx_business_event_delivery_mode(
  p_account_id uuid,
  p_mode text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_current_mode text;
  v_readiness jsonb;
  v_inflight integer;
  v_demoted integer := 0;
  v_synced integer := 0;
begin
  if p_mode not in ('legacy', 'active') then
    raise exception 'FX_BUSINESS_EVENT_MODE_INVALID';
  end if;

  select coalesce(
    (
      select c.mode
      from public.business_event_delivery_controls as c
      where c.account_id = p_account_id
        and c.route_key = 'fx_trade_customer_whatsapp'
    ),
    'legacy'
  ) into v_current_mode;

  if v_current_mode = p_mode then
    return jsonb_build_object(
      'route_key', 'fx_trade_customer_whatsapp',
      'mode', v_current_mode,
      'changed', false
    );
  end if;

  if p_mode = 'active' then
    v_readiness :=
      public.inspect_fx_business_event_cutover_readiness(p_account_id);

    if coalesce((v_readiness ->> 'ready')::boolean, false) is not true then
      raise exception 'FX_BUSINESS_EVENT_CUTOVER_NOT_READY:%', v_readiness::text;
    end if;

    insert into public.business_event_delivery_controls (
      account_id,
      route_key,
      mode,
      created_at,
      updated_at
    ) values (
      p_account_id,
      'fx_trade_customer_whatsapp',
      'active',
      pg_catalog.now(),
      pg_catalog.now()
    )
    on conflict (account_id, route_key) do update
      set mode = excluded.mode,
          updated_at = pg_catalog.now();

    return jsonb_build_object(
      'route_key', 'fx_trade_customer_whatsapp',
      'mode', 'active',
      'changed', true
    );
  end if;

  select count(*)::integer
    into v_inflight
    from public.business_event_outbox as beo
   where beo.account_id = p_account_id
     and beo.delivery_mode = 'active'
     and beo.subject_type = 'fx_trade_request'
     and beo.event_type = any(array[
       'exchange_rate.trade.requested',
       'exchange_rate.trade.approved',
       'exchange_rate.trade.rejected',
       'exchange_rate.trade.completed'
     ]::text[])
     and beo.status in ('sending', 'requires_reconciliation');

  if v_inflight > 0 then
    raise exception 'FX_BUSINESS_EVENT_ROLLBACK_IN_FLIGHT';
  end if;

  -- If the new path already sent a linked event, keep the historical fallback
  -- row in terminal parity so rollback cannot cause it to be resent.
  update public.customer_intent_notifications as cin
     set status = 'sent',
         local_message_id = coalesce(cin.local_message_id, beo.local_message_id),
         sent_at = coalesce(cin.sent_at, beo.sent_at, pg_catalog.now()),
         last_error = null,
         claim_token = null
    from public.business_event_outbox as beo
   where beo.account_id = p_account_id
     and beo.delivery_mode = 'active'
     and beo.subject_type = 'fx_trade_request'
     and beo.status = 'sent'
     and beo.legacy_notification_id = cin.id
     and cin.account_id = p_account_id
     and cin.status <> 'sent';

  get diagnostics v_synced = row_count;

  -- Pending/failed new-path work is handed back to the legacy route by simply
  -- becoming shadow. Sent history remains active as immutable delivery history.
  update public.business_event_outbox as beo
     set delivery_mode = 'shadow',
         claim_token = null,
         claimed_at = null
   where beo.account_id = p_account_id
     and beo.delivery_mode = 'active'
     and beo.subject_type = 'fx_trade_request'
     and beo.event_type = any(array[
       'exchange_rate.trade.requested',
       'exchange_rate.trade.approved',
       'exchange_rate.trade.rejected',
       'exchange_rate.trade.completed'
     ]::text[])
     and beo.status in ('pending', 'failed');

  get diagnostics v_demoted = row_count;

  insert into public.business_event_delivery_controls (
    account_id,
    route_key,
    mode,
    created_at,
    updated_at
  ) values (
    p_account_id,
    'fx_trade_customer_whatsapp',
    'legacy',
    pg_catalog.now(),
    pg_catalog.now()
  )
  on conflict (account_id, route_key) do update
    set mode = excluded.mode,
        updated_at = pg_catalog.now();

  return jsonb_build_object(
    'route_key', 'fx_trade_customer_whatsapp',
    'mode', 'legacy',
    'changed', true,
    'demoted_unsent', v_demoted,
    'synced_legacy_sent', v_synced
  );
end;
$$;

revoke execute on function public.set_fx_business_event_delivery_mode(uuid, text)
  from public, anon, authenticated;

grant execute on function public.set_fx_business_event_delivery_mode(uuid, text)
  to service_role;

-- ------------------------------------------------------------
-- Route-aware FX native producer.
-- ------------------------------------------------------------
create or replace function public.enqueue_fx_trade_business_event()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_event_type text;
  v_correlation_id text;
  v_actor_id text;
  v_dedupe_key text;
  v_route_mode text;
  v_delivery_mode text := 'shadow';
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending_admin' then
      v_event_type := 'exchange_rate.trade.requested';
    end if;
  elsif new.status is distinct from old.status then
    v_event_type := case new.status
      when 'pending_admin' then 'exchange_rate.trade.requested'
      when 'approved_for_contact' then 'exchange_rate.trade.approved'
      when 'rejected' then 'exchange_rate.trade.rejected'
      when 'completed' then 'exchange_rate.trade.completed'
      else null
    end;
  elsif (old.contact_id is null or old.conversation_id is null)
        and new.contact_id is not null
        and new.conversation_id is not null then
    v_event_type := case new.status
      when 'pending_admin' then 'exchange_rate.trade.requested'
      when 'approved_for_contact' then 'exchange_rate.trade.approved'
      when 'rejected' then 'exchange_rate.trade.rejected'
      when 'completed' then 'exchange_rate.trade.completed'
      else null
    end;
  end if;

  if v_event_type is null then
    return new;
  end if;

  if new.status in ('approved_for_contact', 'rejected') then
    v_correlation_id := new.decision_change_request_id::text;
    v_actor_id := new.decided_by::text;
  end if;

  select coalesce(
    (
      select c.mode
      from public.business_event_delivery_controls as c
      where c.account_id = new.account_id
        and c.route_key = 'fx_trade_customer_whatsapp'
    ),
    'legacy'
  ) into v_route_mode;

  if v_route_mode = 'active'
     and new.contact_id is not null
     and new.conversation_id is not null then
    v_delivery_mode := 'active';
  end if;

  v_dedupe_key :=
    v_event_type || ':v1:fx_trade_request:' || new.id::text;

  insert into public.business_event_outbox as beo (
    account_id,
    event_type,
    event_version,
    subject_type,
    subject_id,
    actor_type,
    actor_id,
    audience,
    channel,
    contact_id,
    conversation_id,
    correlation_id,
    causation_id,
    payload,
    delivery_mode,
    status,
    dedupe_key
  ) values (
    new.account_id,
    v_event_type,
    1,
    'fx_trade_request',
    new.id::text,
    case when v_actor_id is null then null else 'member' end,
    v_actor_id,
    'customer',
    'whatsapp',
    new.contact_id,
    new.conversation_id,
    v_correlation_id,
    new.idempotency_key,
    jsonb_build_object('workflow_status', new.status),
    v_delivery_mode,
    'pending',
    v_dedupe_key
  )
  on conflict (account_id, dedupe_key) do update
    set contact_id = coalesce(beo.contact_id, excluded.contact_id),
        conversation_id = coalesce(beo.conversation_id, excluded.conversation_id),
        correlation_id = coalesce(beo.correlation_id, excluded.correlation_id),
        actor_type = coalesce(beo.actor_type, excluded.actor_type),
        actor_id = coalesce(beo.actor_id, excluded.actor_id),
        delivery_mode = case
          when beo.delivery_mode = 'shadow'
           and excluded.delivery_mode = 'active'
           and beo.status = 'pending'
           and beo.created_at >= pg_catalog.transaction_timestamp()
            then 'active'
          else beo.delivery_mode
        end;

  return new;
end;
$$;

revoke all on function public.enqueue_fx_trade_business_event()
  from public, anon, authenticated;

drop trigger if exists exchange_trade_requests_business_event_shadow
  on public.exchange_trade_requests;
drop trigger if exists exchange_trade_requests_business_event_route
  on public.exchange_trade_requests;

create trigger exchange_trade_requests_business_event_route
  after insert or update of status, contact_id, conversation_id
  on public.exchange_trade_requests
  for each row
  execute function public.enqueue_fx_trade_business_event();

-- ------------------------------------------------------------
-- If the historical FX notification trigger fires before/after the native
-- producer, ensure the just-created strangler-linked event follows the active
-- route. The zz_ name intentionally places this AFTER the general mirror
-- trigger for the same AFTER INSERT event.
-- ------------------------------------------------------------
create or replace function public.route_linked_fx_business_event()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
begin
  if new.fx_trade_request_id is null then
    return new;
  end if;

  if exists (
    select 1
    from public.business_event_delivery_controls as c
    where c.account_id = new.account_id
      and c.route_key = 'fx_trade_customer_whatsapp'
      and c.mode = 'active'
  ) then
    update public.business_event_outbox as beo
       set delivery_mode = 'active'
     where beo.account_id = new.account_id
       and beo.legacy_notification_id = new.id
       and beo.subject_type = 'fx_trade_request'
       and beo.delivery_mode = 'shadow'
       and beo.status = 'pending'
       and beo.created_at >= pg_catalog.transaction_timestamp();
  end if;

  return new;
end;
$$;

revoke all on function public.route_linked_fx_business_event()
  from public, anon, authenticated;

drop trigger if exists zz_customer_intent_notifications_fx_business_event_route
  on public.customer_intent_notifications;

create trigger zz_customer_intent_notifications_fx_business_event_route
  after insert on public.customer_intent_notifications
  for each row
  execute function public.route_linked_fx_business_event();

-- ------------------------------------------------------------
-- Legacy fallback claim.
--
-- Non-FX behavior is unchanged. FX rows are claimed by the historical path
-- unless the account has explicitly activated the new FX route.
-- ------------------------------------------------------------
create or replace function public.claim_customer_business_notifications(
  p_account_id uuid,
  p_change_request_id uuid default null,
  p_limit integer default 20
)
returns table(
  id uuid,
  contact_id uuid,
  conversation_id uuid,
  message_text text,
  attempts integer,
  claim_token uuid,
  intent_id uuid,
  fx_trade_request_id uuid,
  event_type text,
  change_request_id uuid
)
language sql
security definer
set search_path = pg_catalog, public, extensions
as $$
  with candidates as (
    select cin.id
    from public.customer_intent_notifications as cin
    where cin.account_id = p_account_id
      and cin.status = 'pending'
      and cin.available_at <= pg_catalog.now()
      and (p_change_request_id is null or cin.change_request_id = p_change_request_id)
      and (
        cin.fx_trade_request_id is null
        or not exists (
          select 1
          from public.business_event_delivery_controls as c
          where c.account_id = cin.account_id
            and c.route_key = 'fx_trade_customer_whatsapp'
            and c.mode = 'active'
        )
      )
    order by cin.created_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 20), 100))
  ), claimed as (
    update public.customer_intent_notifications as cin
       set status = 'sending',
           claim_token = gen_random_uuid(),
           claimed_at = pg_catalog.now(),
           attempts = cin.attempts + 1,
           last_error = null
      from candidates as c
     where cin.id = c.id
    returning cin.id,
              cin.contact_id,
              cin.conversation_id,
              cin.message_text,
              cin.attempts,
              cin.claim_token,
              cin.intent_id,
              cin.fx_trade_request_id,
              cin.event_type,
              cin.change_request_id
  )
  select c.id,
         c.contact_id,
         c.conversation_id,
         c.message_text,
         c.attempts,
         c.claim_token,
         c.intent_id,
         c.fx_trade_request_id,
         c.event_type,
         c.change_request_id
  from claimed as c
  order by c.id;
$$;

revoke execute on function public.claim_customer_business_notifications(uuid, uuid, integer)
  from public, anon, authenticated;

grant execute on function public.claim_customer_business_notifications(uuid, uuid, integer)
  to service_role;

-- ------------------------------------------------------------
-- Generic active customer/WhatsApp claim used by the platform delivery worker.
-- It contains no FX-specific selector; route-specific knowledge stays in
-- producers/controls.
-- ------------------------------------------------------------
create or replace function public.claim_business_event_delivery(
  p_account_id uuid,
  p_correlation_id text default null,
  p_limit integer default 20
)
returns table(
  id uuid,
  event_type text,
  event_version integer,
  subject_type text,
  subject_id text,
  audience text,
  channel text,
  contact_id uuid,
  conversation_id uuid,
  correlation_id text,
  causation_id text,
  payload jsonb,
  attempts integer,
  claim_token uuid,
  legacy_notification_id uuid,
  dedupe_key text
)
language sql
security invoker
set search_path = pg_catalog, public, extensions
as $$
  with candidates as (
    select beo.id
    from public.business_event_outbox as beo
    where beo.account_id = p_account_id
      and beo.delivery_mode = 'active'
      and beo.status = 'pending'
      and beo.available_at <= pg_catalog.now()
      and beo.audience = 'customer'
      and beo.channel = 'whatsapp'
      and (
        p_correlation_id is null
        or beo.correlation_id = p_correlation_id
      )
    order by beo.created_at asc, beo.id asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 20), 100))
  ), claimed as (
    update public.business_event_outbox as beo
       set status = 'sending',
           claim_token = gen_random_uuid(),
           claimed_at = pg_catalog.now(),
           attempts = beo.attempts + 1,
           last_error = null
      from candidates as c
     where beo.id = c.id
    returning beo.*
  )
  select c.id,
         c.event_type,
         c.event_version,
         c.subject_type,
         c.subject_id,
         c.audience,
         c.channel,
         c.contact_id,
         c.conversation_id,
         c.correlation_id,
         c.causation_id,
         c.payload,
         c.attempts,
         c.claim_token,
         c.legacy_notification_id,
         c.dedupe_key
    from claimed as c
   order by c.id;
$$;

revoke execute on function public.claim_business_event_delivery(uuid, text, integer)
  from public, anon, authenticated;

grant execute on function public.claim_business_event_delivery(uuid, text, integer)
  to service_role;
