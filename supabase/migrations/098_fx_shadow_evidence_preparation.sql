-- ============================================================
-- 098_fx_shadow_evidence_preparation.sql
-- Prepare real historical FX shadow evidence without sending customer messages.
--
-- This migration is operationally conservative:
--   * no delivery route is activated
--   * no historical shadow row becomes active
--   * legacy rows are never marked sent unless transport actually sent them
--   * a pending FX notification can become terminal "superseded" only when a
--     later lifecycle notification for the same trade was already sent and no
--     transport reservation exists for the older notification
-- ============================================================

-- ------------------------------------------------------------
-- Terminal legacy status for lifecycle messages that became obsolete before
-- delivery. Existing workers claim only pending rows, so this is additive.
-- ------------------------------------------------------------
alter table public.customer_intent_notifications
  drop constraint if exists customer_intent_notifications_status_check;

alter table public.customer_intent_notifications
  add constraint customer_intent_notifications_status_check
  check (status in (
    'pending',
    'sending',
    'sent',
    'requires_reconciliation',
    'failed',
    'superseded'
  ));

comment on column public.customer_intent_notifications.status is
  'Delivery state. superseded means a newer lifecycle notification for the same subject was already sent before this pending row could be delivered.';

-- ------------------------------------------------------------
-- Controlled historical adapter.
--
-- Replays ONLY existing canonical legacy FX notifications into the general
-- outbox as shadow rows. It preserves the original event time and attaches the
-- legacy notification id for parity checks / transport idempotency.
-- ------------------------------------------------------------
create or replace function public.backfill_fx_business_event_shadow_history(
  p_account_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_affected integer := 0;
begin
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
    dedupe_key,
    created_at
  )
  select
    cin.account_id,
    cin.event_type,
    1,
    'fx_trade_request',
    cin.fx_trade_request_id::text,
    'customer',
    'whatsapp',
    cin.contact_id,
    cin.conversation_id,
    cin.change_request_id::text,
    etr.idempotency_key,
    jsonb_build_object(
      'workflow_status',
        case cin.event_type
          when 'exchange_rate.trade.requested' then 'pending_admin'
          when 'exchange_rate.trade.approved' then 'approved_for_contact'
          when 'exchange_rate.trade.rejected' then 'rejected'
          when 'exchange_rate.trade.completed' then 'completed'
        end,
      'backfilled_from_legacy', true
    ),
    'shadow',
    'pending',
    cin.id,
    cin.event_type || ':v1:fx_trade_request:' || cin.fx_trade_request_id::text,
    cin.created_at
  from public.customer_intent_notifications as cin
  join public.exchange_trade_requests as etr
    on etr.account_id = cin.account_id
   and etr.id = cin.fx_trade_request_id
  where cin.account_id = p_account_id
    and cin.fx_trade_request_id is not null
    and cin.event_type = any(array[
      'exchange_rate.trade.requested',
      'exchange_rate.trade.approved',
      'exchange_rate.trade.rejected',
      'exchange_rate.trade.completed'
    ]::text[])
  on conflict (account_id, dedupe_key) do update
    set legacy_notification_id = coalesce(
          beo.legacy_notification_id,
          excluded.legacy_notification_id
        ),
        contact_id = coalesce(beo.contact_id, excluded.contact_id),
        conversation_id = coalesce(beo.conversation_id, excluded.conversation_id),
        correlation_id = coalesce(beo.correlation_id, excluded.correlation_id),
        causation_id = coalesce(beo.causation_id, excluded.causation_id);

  get diagnostics v_affected = row_count;

  return jsonb_build_object(
    'account_id', p_account_id,
    'affected_rows', v_affected,
    'delivery_mode', 'shadow'
  );
end;
$$;

revoke execute on function public.backfill_fx_business_event_shadow_history(uuid)
  from public, anon, authenticated;

grant execute on function public.backfill_fx_business_event_shadow_history(uuid)
  to service_role;

-- ------------------------------------------------------------
-- Reconcile obsolete legacy FX notifications without pretending they were sent.
--
-- Example:
--   requested = pending
--   approved  = sent
-- => requested becomes superseded.
--
-- A local transport reservation blocks supersession because that indicates an
-- attempted send that requires normal reconciliation semantics.
-- ------------------------------------------------------------
create or replace function public.reconcile_superseded_fx_customer_notifications(
  p_account_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_superseded integer := 0;
begin
  with candidates as (
    select older.id
    from public.customer_intent_notifications as older
    where older.account_id = p_account_id
      and older.fx_trade_request_id is not null
      and older.status = 'pending'
      and older.event_type = any(array[
        'exchange_rate.trade.requested',
        'exchange_rate.trade.approved'
      ]::text[])
      and not exists (
        select 1
        from public.messages as m
        where m.engine_idempotency_key =
          'customer-intent-notification:' || older.id::text
      )
      and exists (
        select 1
        from public.customer_intent_notifications as newer
        where newer.account_id = older.account_id
          and newer.fx_trade_request_id = older.fx_trade_request_id
          and newer.status = 'sent'
          and newer.created_at > older.created_at
          and (
            (
              older.event_type = 'exchange_rate.trade.requested'
              and newer.event_type = any(array[
                'exchange_rate.trade.approved',
                'exchange_rate.trade.rejected',
                'exchange_rate.trade.completed'
              ]::text[])
            )
            or (
              older.event_type = 'exchange_rate.trade.approved'
              and newer.event_type = 'exchange_rate.trade.completed'
            )
          )
      )
    for update skip locked
  ), updated as (
    update public.customer_intent_notifications as cin
       set status = 'superseded',
           claim_token = null,
           claimed_at = null,
           last_error = 'SUPERSEDED_BY_LATER_FX_EVENT'
      from candidates as c
     where cin.id = c.id
    returning cin.id
  )
  select count(*)::integer
    into v_superseded
    from updated;

  return jsonb_build_object(
    'account_id', p_account_id,
    'superseded_rows', v_superseded
  );
end;
$$;

revoke execute on function public.reconcile_superseded_fx_customer_notifications(uuid)
  from public, anon, authenticated;

grant execute on function public.reconcile_superseded_fx_customer_notifications(uuid)
  to service_role;

-- ------------------------------------------------------------
-- Filtered shadow claim for domain-scoped verification runs.
-- This prevents an FX readiness operation from consuming pending shadow work
-- owned by Coverage or a future domain.
-- ------------------------------------------------------------
create or replace function public.claim_business_event_outbox_shadow_for_event_types(
  p_account_id uuid,
  p_event_types text[],
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
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
begin
  if p_event_types is null or cardinality(p_event_types) = 0 then
    raise exception 'SHADOW_EVENT_TYPES_REQUIRED';
  end if;

  return query
  with candidates as (
    select beo.id
    from public.business_event_outbox as beo
    where beo.account_id = p_account_id
      and beo.delivery_mode = 'shadow'
      and beo.event_type = any(p_event_types)
      and (
        beo.shadow_projection_status = 'pending'
        or (
          beo.shadow_projection_status = 'checking'
          and beo.shadow_projection_claimed_at
                < pg_catalog.now() - interval '15 minutes'
        )
      )
    order by beo.created_at asc, beo.id asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ), checked as (
    update public.business_event_outbox as beo
       set shadow_projection_status = 'checking',
           shadow_projection_attempts = beo.shadow_projection_attempts + 1,
           shadow_projection_claimed_at = pg_catalog.now(),
           shadow_projection_error = null,
           shadow_checked_at = pg_catalog.now()
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
end;
$$;

revoke execute on function public.claim_business_event_outbox_shadow_for_event_types(
  uuid, text[], integer
) from public, anon, authenticated;

grant execute on function public.claim_business_event_outbox_shadow_for_event_types(
  uuid, text[], integer
) to service_role;
