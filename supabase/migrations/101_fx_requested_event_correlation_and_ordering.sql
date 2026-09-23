-- ============================================================
-- 101_fx_requested_event_correlation_and_ordering.sql
--
-- Repair two cutover gaps found by the first real TEST activation:
--   1. exchange_rate.trade.requested had no correlation_id, so the
--      synchronous AI runtime could not flush only the event created by
--      the current customer run.
--   2. a later correlated event (approved/rejected) could be claimed while
--      an older event for the same subject was still pending.
--
-- The changes remain domain-neutral at the delivery boundary:
-- claim_business_event_delivery() now includes older pending events for
-- the same subject whenever a correlated event is requested.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Preserve the originating AI run on the canonical requested event.
--    Approved/rejected events continue to correlate to their Change Request.
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

  if v_event_type = 'exchange_rate.trade.requested' then
    v_correlation_id := nullif(new.metadata ->> 'run_id', '');
  elsif new.status in ('approved_for_contact', 'rejected') then
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

-- Existing requested events can recover their run correlation from the
-- immutable metadata snapshot written by exchange_rates.record_trade_request.
update public.business_event_outbox as beo
   set correlation_id = nullif(etr.metadata ->> 'run_id', '')
  from public.exchange_trade_requests as etr
 where beo.account_id = etr.account_id
   and beo.subject_type = 'fx_trade_request'
   and beo.subject_id = etr.id::text
   and beo.event_type = 'exchange_rate.trade.requested'
   and beo.correlation_id is null
   and nullif(etr.metadata ->> 'run_id', '') is not null;

-- ------------------------------------------------------------
-- 2) Correlated delivery must not jump over an older pending event for the
--    same subject. If an approved/rejected event is requested by correlation,
--    older pending customer/WhatsApp events for that subject are claimed in
--    the same batch first.
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
  with correlated_subjects as (
    select
      beo.subject_type,
      beo.subject_id,
      max(beo.created_at) as correlated_created_at
    from public.business_event_outbox as beo
    where p_correlation_id is not null
      and beo.account_id = p_account_id
      and beo.delivery_mode = 'active'
      and beo.audience = 'customer'
      and beo.channel = 'whatsapp'
      and beo.correlation_id = p_correlation_id
    group by beo.subject_type, beo.subject_id
  ), candidates as (
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
        or exists (
          select 1
          from correlated_subjects as cs
          where cs.subject_type = beo.subject_type
            and cs.subject_id = beo.subject_id
            and beo.created_at <= cs.correlated_created_at
        )
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
   order by c.created_at asc, c.id asc;
$$;

revoke execute on function public.claim_business_event_delivery(uuid, text, integer)
  from public, anon, authenticated;

grant execute on function public.claim_business_event_delivery(uuid, text, integer)
  to service_role;

-- ------------------------------------------------------------
-- 3) One-time repair for active cutover rows that were already overtaken by
--    a later authoritative FX state before this ordering rule existed.
--    They must never be delivered after approval/rejection.
-- ------------------------------------------------------------
update public.customer_intent_notifications as cin
   set status = 'failed',
       claim_token = null,
       last_error = 'SUPERSEDED_BY_LATER_FX_STATE'
  from public.exchange_trade_requests as etr
 where cin.account_id = etr.account_id
   and cin.fx_trade_request_id = etr.id
   and cin.event_type = 'exchange_rate.trade.requested'
   and cin.status = 'pending'
   and etr.status <> 'pending_admin'
   and exists (
     select 1
     from public.business_event_outbox as beo
     where beo.account_id = cin.account_id
       and beo.legacy_notification_id = cin.id
       and beo.subject_type = 'fx_trade_request'
       and beo.event_type = 'exchange_rate.trade.requested'
       and beo.delivery_mode = 'active'
       and beo.status in ('pending', 'failed')
   );

update public.business_event_outbox as beo
   set delivery_mode = 'shadow',
       status = 'failed',
       claim_token = null,
       claimed_at = null,
       last_error = 'SUPERSEDED_BY_LATER_FX_STATE',
       shadow_projection_status = case
         when beo.legacy_notification_id is not null then 'matched_legacy'
         else beo.shadow_projection_status
       end,
       shadow_projection_checked_at = coalesce(
         beo.shadow_projection_checked_at,
         pg_catalog.now()
       ),
       shadow_projection_error = null
  from public.exchange_trade_requests as etr
 where beo.account_id = etr.account_id
   and beo.subject_type = 'fx_trade_request'
   and beo.subject_id = etr.id::text
   and beo.event_type = 'exchange_rate.trade.requested'
   and beo.delivery_mode = 'active'
   and beo.status in ('pending', 'failed')
   and etr.status <> 'pending_admin';
