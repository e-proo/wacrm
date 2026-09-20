-- ============================================================
-- 090_general_business_outbox.sql
-- Phase E / expand-first general Business Event outbox.
--
-- Goals:
--   1. Introduce a domain-neutral, versioned business_event_outbox.
--   2. Keep customer_intent_notifications untouched as the active sender path.
--   3. Dual-write canonical FX/Coverage events into SHADOW mode atomically.
--   4. Mirror legacy customer notifications for parity comparison.
--   5. Provide a shadow-claim RPC that never sends or changes delivery status.
--
-- No cutover happens in this migration. delivery_mode defaults to 'shadow';
-- active WhatsApp delivery remains owned by customer_intent_notifications.
-- ============================================================

create table if not exists public.business_event_outbox (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,

  event_type text not null
    check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  event_version integer not null default 1
    check (event_version > 0),

  subject_type text not null
    check (subject_type ~ '^[a-z][a-z0-9_]*$'),
  subject_id text not null
    check (char_length(subject_id) between 1 and 200),

  actor_type text
    check (actor_type is null or actor_type ~ '^[a-z][a-z0-9_]*$'),
  actor_id text,

  audience text
    check (audience is null or audience in ('customer', 'admin', 'internal')),
  channel text
    check (channel is null or channel in ('whatsapp', 'in_app', 'email', 'sms')),

  contact_id uuid references public.contacts(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,

  correlation_id text,
  causation_id text,

  payload jsonb not null default '{}'::jsonb,

  -- Shadow is mandatory during Phase E parity verification. Only a later
  -- cutover migration may promote selected producers/consumers to active.
  delivery_mode text not null default 'shadow'
    check (delivery_mode in ('shadow', 'active')),

  status text not null default 'pending'
    check (status in (
      'pending', 'sending', 'sent', 'requires_reconciliation', 'failed'
    )),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  claim_token uuid,
  claimed_at timestamptz,
  shadow_checked_at timestamptz,
  local_message_id uuid references public.messages(id) on delete set null,
  sent_at timestamptz,
  last_error text,

  -- Temporary strangler bridge. Kept nullable so native domain events do not
  -- depend on the historical notification table.
  legacy_notification_id uuid,

  -- Producer-owned deterministic identity. The platform only enforces
  -- uniqueness per account; domains decide the business identity semantics.
  dedupe_key text not null
    check (char_length(dedupe_key) between 8 and 500),

  created_at timestamptz not null default now()
);

create unique index if not exists business_event_outbox_account_dedupe_uidx
  on public.business_event_outbox(account_id, dedupe_key);

create unique index if not exists business_event_outbox_legacy_notification_uidx
  on public.business_event_outbox(legacy_notification_id)
  where legacy_notification_id is not null;

create index if not exists business_event_outbox_queue_idx
  on public.business_event_outbox(
    account_id, delivery_mode, status, available_at, created_at
  );

create index if not exists business_event_outbox_subject_idx
  on public.business_event_outbox(
    account_id, subject_type, subject_id, created_at desc
  );

create index if not exists business_event_outbox_event_idx
  on public.business_event_outbox(
    account_id, event_type, event_version, created_at desc
  );

alter table public.business_event_outbox enable row level security;

-- Keep the outbox private. The service-role runtime uses PostgREST/RPC, so
-- grant it explicitly; anon/authenticated receive no table privileges.
revoke all on table public.business_event_outbox from public, anon, authenticated;
grant select, insert, update, delete on table public.business_event_outbox to service_role;

comment on table public.business_event_outbox is
  'General versioned business-event outbox. Phase E starts in shadow mode; legacy customer_intent_notifications remains the active delivery path until verified cutover.';

comment on column public.business_event_outbox.legacy_notification_id is
  'Temporary strangler link to customer_intent_notifications for shadow parity checks. Not part of the long-term domain contract.';

comment on column public.business_event_outbox.dedupe_key is
  'Producer-owned deterministic business-event identity, unique per account.';

-- -----------------------------------------------------------------
-- Shadow claim: atomically marks never-compared shadow rows as checked and
-- returns them. It does NOT change delivery status, attempts, or send claims.
-- Concurrent shadow workers cannot compare the same row.
-- -----------------------------------------------------------------
create or replace function public.claim_business_event_outbox_shadow(
  p_account_id uuid,
  p_limit integer default 50
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
  legacy_notification_id uuid,
  dedupe_key text,
  created_at timestamptz,
  shadow_checked_at timestamptz
)
language sql
security invoker
set search_path = pg_catalog, public, extensions
as $$
  with candidates as (
    select beo.id
    from public.business_event_outbox as beo
    where beo.account_id = p_account_id
      and beo.delivery_mode = 'shadow'
      and beo.shadow_checked_at is null
    order by beo.created_at asc, beo.id asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ), checked as (
    update public.business_event_outbox as beo
       set shadow_checked_at = pg_catalog.now()
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
         c.legacy_notification_id,
         c.dedupe_key,
         c.created_at,
         c.shadow_checked_at
    from checked as c
   order by c.created_at asc, c.id asc;
$$;

revoke execute on function public.claim_business_event_outbox_shadow(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_business_event_outbox_shadow(uuid, integer)
  to service_role;

-- -----------------------------------------------------------------
-- Future active claim. It is safe to ship now because no producer is promoted
-- to delivery_mode='active' by this migration. The eventual cutover can reuse
-- this exact SKIP LOCKED contract without changing producer semantics.
-- -----------------------------------------------------------------
create or replace function public.claim_business_event_outbox(
  p_account_id uuid,
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
         c.dedupe_key
    from claimed as c
   order by c.id;
$$;

revoke execute on function public.claim_business_event_outbox(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_business_event_outbox(uuid, integer)
  to service_role;

-- -----------------------------------------------------------------
-- Legacy adapter: every new historical notification row is mirrored into the
-- generic outbox in shadow mode. Canonical native producers use the SAME
-- dedupe key, so this adapter links legacy_notification_id instead of creating
-- a duplicate when a native event already exists.
-- -----------------------------------------------------------------
create or replace function public.mirror_legacy_customer_notification_to_business_outbox()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_event_type text;
  v_subject_type text;
  v_subject_id text;
  v_causation_id text;
  v_target_type text;
  v_execution_result jsonb;
  v_dedupe_key text;
begin
  if new.fx_trade_request_id is not null then
    v_event_type := new.event_type;
    v_subject_type := 'fx_trade_request';
    v_subject_id := new.fx_trade_request_id::text;
  else
    if new.change_request_id is not null then
      select cr.target_type, cr.execution_result
        into v_target_type, v_execution_result
        from public.change_requests as cr
       where cr.account_id = new.account_id
         and cr.id = new.change_request_id;
    end if;

    if new.event_type = 'approved_and_applied'
       and v_target_type = 'coverage_offer' then
      v_subject_id := nullif(v_execution_result #>> '{offer,id}', '');
      if v_subject_id is not null then
        v_event_type := 'coverage.offer.approved';
        v_subject_type := 'coverage_offer';
      end if;
    elsif new.event_type = 'approved_and_applied'
       and v_target_type = 'coverage_request' then
      v_subject_id := nullif(v_execution_result #>> '{request,id}', '');
      if v_subject_id is not null then
        v_event_type := 'coverage.request.approved';
        v_subject_type := 'coverage_request';
      end if;
    end if;

    if v_event_type is null then
      v_event_type := case new.event_type
        when 'approved_and_applied' then 'service_request.approved'
        when 'rejected' then 'service_request.rejected'
        when 'needs_clarification' then 'service_request.needs_clarification'
        when 'matched' then 'service_request.matched'
        else null
      end;
      v_subject_type := 'service_intent';
      v_subject_id := new.intent_id::text;
    end if;

    v_causation_id := new.intent_id::text;
  end if;

  if v_event_type is null or v_subject_id is null then
    return new;
  end if;

  v_dedupe_key :=
    v_event_type || ':v1:' || v_subject_type || ':' || v_subject_id;

  insert into public.business_event_outbox as beo (
    account_id,
    event_type,
    event_version,
    subject_type,
    subject_id,
    audience,
    channel,
    contact_id,
    conversation_id,
    correlation_id,
    causation_id,
    payload,
    delivery_mode,
    status,
    legacy_notification_id,
    dedupe_key
  ) values (
    new.account_id,
    v_event_type,
    1,
    v_subject_type,
    v_subject_id,
    'customer',
    'whatsapp',
    new.contact_id,
    new.conversation_id,
    new.change_request_id::text,
    v_causation_id,
    jsonb_build_object(
      'legacy_event_type', new.event_type,
      'legacy_notification_id', new.id
    ),
    'shadow',
    'pending',
    new.id,
    v_dedupe_key
  )
  on conflict (account_id, dedupe_key) do update
    set legacy_notification_id = coalesce(
          beo.legacy_notification_id,
          excluded.legacy_notification_id
        ),
        contact_id = coalesce(
          beo.contact_id,
          excluded.contact_id
        ),
        conversation_id = coalesce(
          beo.conversation_id,
          excluded.conversation_id
        ),
        correlation_id = coalesce(
          beo.correlation_id,
          excluded.correlation_id
        ),
        causation_id = coalesce(
          beo.causation_id,
          excluded.causation_id
        );

  return new;
end;
$$;

revoke all on function public.mirror_legacy_customer_notification_to_business_outbox()
  from public, anon, authenticated;

drop trigger if exists customer_intent_notifications_business_event_shadow
  on public.customer_intent_notifications;

create trigger customer_intent_notifications_business_event_shadow
  after insert on public.customer_intent_notifications
  for each row
  execute function public.mirror_legacy_customer_notification_to_business_outbox();

-- -----------------------------------------------------------------
-- FX native producer. This is independent from the legacy notification trigger
-- in migration 089. Both inserts are part of the SAME trade mutation
-- transaction, and the common dedupe key lets the legacy adapter attach itself
-- to this native event rather than create a second row.
-- -----------------------------------------------------------------
create or replace function public.enqueue_fx_trade_business_event_shadow()
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
    -- Revisit the existing event only to attach routing metadata.
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
    'shadow',
    'pending',
    v_dedupe_key
  )
  on conflict (account_id, dedupe_key) do update
    set contact_id = coalesce(
          beo.contact_id,
          excluded.contact_id
        ),
        conversation_id = coalesce(
          beo.conversation_id,
          excluded.conversation_id
        ),
        correlation_id = coalesce(
          beo.correlation_id,
          excluded.correlation_id
        ),
        actor_type = coalesce(
          beo.actor_type,
          excluded.actor_type
        ),
        actor_id = coalesce(
          beo.actor_id,
          excluded.actor_id
        );

  return new;
end;
$$;

revoke all on function public.enqueue_fx_trade_business_event_shadow()
  from public, anon, authenticated;

drop trigger if exists exchange_trade_requests_business_event_shadow
  on public.exchange_trade_requests;

create trigger exchange_trade_requests_business_event_shadow
  after insert or update of status, contact_id, conversation_id
  on public.exchange_trade_requests
  for each row
  execute function public.enqueue_fx_trade_business_event_shadow();

-- -----------------------------------------------------------------
-- Coverage offer producer.
-- The event snapshot is embedded because the offer row remains mutable after
-- the event. Reservation-only status changes intentionally do not become
-- public business-event names; coverage.match.reserved carries that meaning.
-- -----------------------------------------------------------------
create or replace function public.enqueue_coverage_offer_business_event_shadow()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_event_type text;
  v_intent_id uuid;
  v_conversation_id uuid;
  v_actor_id text;
  v_audience text;
  v_channel text;
  v_dedupe_key text;
begin
  if tg_op = 'INSERT' then
    if new.status = 'active' and new.source_change_request_id is not null then
      v_event_type := 'coverage.offer.approved';
      v_actor_id := new.created_by::text;
      v_audience := 'customer';
      v_channel := 'whatsapp';
    elsif new.status = 'active' then
      v_event_type := 'coverage.offer.activated';
    end if;
  elsif new.status is distinct from old.status then
    if old.status = 'draft' and new.status = 'active' then
      v_event_type := 'coverage.offer.activated';
    elsif new.status = 'cancelled' then
      v_event_type := 'coverage.offer.cancelled';
    elsif new.status = 'fulfilled' then
      v_event_type := 'coverage.offer.fulfilled';
    elsif new.status = 'expired' then
      v_event_type := 'coverage.offer.expired';
    end if;
  end if;

  if v_event_type is null then
    return new;
  end if;

  if new.source_change_request_id is not null then
    select ci.id, ci.conversation_id
      into v_intent_id, v_conversation_id
      from public.change_requests as cr
      left join public.customer_intents as ci
        on ci.account_id = new.account_id
       and ci.id::text = cr.proposed_payload ->> 'intent_id'
     where cr.account_id = new.account_id
       and cr.id = new.source_change_request_id;
  end if;

  v_dedupe_key :=
    v_event_type || ':v1:coverage_offer:' || new.id::text;

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
    'coverage_offer',
    new.id::text,
    case when v_actor_id is null then null else 'member' end,
    v_actor_id,
    v_audience,
    v_channel,
    case when v_audience = 'customer' then new.provider_contact_id else null end,
    case when v_audience = 'customer' then v_conversation_id else null end,
    new.source_change_request_id::text,
    v_intent_id::text,
    jsonb_build_object(
      'service_id', new.service_id,
      'reference', new.reference_code,
      'amount', new.total_amount::text,
      'currency', new.currency,
      'attributes', new.attributes,
      'commission_per_thousand',
        case when new.commission_per_thousand is null
          then null else new.commission_per_thousand::text end,
      'commission_amount',
        case when new.commission_amount is null
          then null else new.commission_amount::text end,
      'commission_currency', new.commission_currency,
      'deal_date', new.deal_date::text,
      'status_after', new.status,
      'version', new.version
    ),
    'shadow',
    'pending',
    v_dedupe_key
  )
  on conflict (account_id, dedupe_key) do nothing;

  return new;
end;
$$;

revoke all on function public.enqueue_coverage_offer_business_event_shadow()
  from public, anon, authenticated;

drop trigger if exists coverage_offers_business_event_shadow
  on public.coverage_offers;

create trigger coverage_offers_business_event_shadow
  after insert or update of status
  on public.coverage_offers
  for each row
  execute function public.enqueue_coverage_offer_business_event_shadow();

-- -----------------------------------------------------------------
-- Coverage request producer.
-- -----------------------------------------------------------------
create or replace function public.enqueue_coverage_request_business_event_shadow()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_event_type text;
  v_intent_id uuid;
  v_conversation_id uuid;
  v_actor_id text;
  v_audience text;
  v_channel text;
  v_dedupe_key text;
begin
  if tg_op = 'INSERT' then
    if new.status = 'active' and new.source_change_request_id is not null then
      v_event_type := 'coverage.request.approved';
      v_actor_id := new.created_by::text;
      v_audience := 'customer';
      v_channel := 'whatsapp';
    elsif new.status = 'active' then
      v_event_type := 'coverage.request.activated';
    end if;
  elsif new.status is distinct from old.status then
    if old.status = 'draft' and new.status = 'active' then
      v_event_type := 'coverage.request.activated';
    elsif new.status = 'cancelled' then
      v_event_type := 'coverage.request.cancelled';
    elsif new.status = 'fulfilled' then
      v_event_type := 'coverage.request.fulfilled';
    elsif new.status = 'expired' then
      v_event_type := 'coverage.request.expired';
    end if;
  end if;

  if v_event_type is null then
    return new;
  end if;

  if new.source_change_request_id is not null then
    select ci.id, ci.conversation_id
      into v_intent_id, v_conversation_id
      from public.change_requests as cr
      left join public.customer_intents as ci
        on ci.account_id = new.account_id
       and ci.id::text = cr.proposed_payload ->> 'intent_id'
     where cr.account_id = new.account_id
       and cr.id = new.source_change_request_id;
  end if;

  v_dedupe_key :=
    v_event_type || ':v1:coverage_request:' || new.id::text;

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
    'coverage_request',
    new.id::text,
    case when v_actor_id is null then null else 'member' end,
    v_actor_id,
    v_audience,
    v_channel,
    case when v_audience = 'customer' then new.requester_contact_id else null end,
    case when v_audience = 'customer' then v_conversation_id else null end,
    new.source_change_request_id::text,
    v_intent_id::text,
    jsonb_build_object(
      'service_id', new.service_id,
      'amount', new.requested_amount::text,
      'currency', new.currency,
      'attributes', new.attributes,
      'commission_per_thousand',
        case when new.commission_per_thousand is null
          then null else new.commission_per_thousand::text end,
      'commission_amount',
        case when new.commission_amount is null
          then null else new.commission_amount::text end,
      'commission_currency', new.commission_currency,
      'deal_date', new.deal_date::text,
      'status_after', new.status,
      'version', new.version
    ),
    'shadow',
    'pending',
    v_dedupe_key
  )
  on conflict (account_id, dedupe_key) do nothing;

  return new;
end;
$$;

revoke all on function public.enqueue_coverage_request_business_event_shadow()
  from public, anon, authenticated;

drop trigger if exists coverage_requests_business_event_shadow
  on public.coverage_requests;

create trigger coverage_requests_business_event_shadow
  after insert or update of status
  on public.coverage_requests
  for each row
  execute function public.enqueue_coverage_request_business_event_shadow();

-- -----------------------------------------------------------------
-- Coverage match producer. Only lifecycle operations implemented today are
-- emitted: reserved and released. Confirmed/fulfilled are intentionally not
-- invented until a real authoritative mutation path exists.
-- -----------------------------------------------------------------
create or replace function public.enqueue_coverage_match_business_event_shadow()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_event_type text;
  v_actor_id text;
  v_dedupe_key text;
begin
  if tg_op = 'INSERT' and new.status = 'reserved' then
    v_event_type := 'coverage.match.reserved';
    v_actor_id := new.created_by::text;
  elsif tg_op = 'UPDATE'
        and new.status is distinct from old.status
        and new.status = 'released' then
    v_event_type := 'coverage.match.released';
  end if;

  if v_event_type is null then
    return new;
  end if;

  v_dedupe_key :=
    v_event_type || ':v1:coverage_match:' || new.id::text;

  insert into public.business_event_outbox as beo (
    account_id,
    event_type,
    event_version,
    subject_type,
    subject_id,
    actor_type,
    actor_id,
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
    'coverage_match',
    new.id::text,
    case when v_actor_id is null then null else 'member' end,
    v_actor_id,
    null,
    new.idempotency_key,
    jsonb_build_object(
      'offer_id', new.offer_id,
      'request_id', new.request_id,
      'service_id', new.service_id,
      'matched_amount', new.matched_amount::text,
      'currency', new.currency,
      'rate_snapshot', new.rate_snapshot,
      'fee_snapshot', new.fee_snapshot,
      'customer_fee_snapshot',
        case when new.customer_fee_snapshot is null
          then null else new.customer_fee_snapshot::text end,
      'status_after', new.status,
      'reserved_until', new.reserved_until
    ),
    'shadow',
    'pending',
    v_dedupe_key
  )
  on conflict (account_id, dedupe_key) do nothing;

  return new;
end;
$$;

revoke all on function public.enqueue_coverage_match_business_event_shadow()
  from public, anon, authenticated;

drop trigger if exists coverage_matches_business_event_shadow
  on public.coverage_matches;

create trigger coverage_matches_business_event_shadow
  after insert or update of status
  on public.coverage_matches
  for each row
  execute function public.enqueue_coverage_match_business_event_shadow();
