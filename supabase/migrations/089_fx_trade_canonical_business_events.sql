-- ============================================================
-- 089_fx_trade_canonical_business_events.sql
-- Canonical FX V2 customer business-event contract.
--
-- Internal workflow statuses remain domain implementation details:
--   pending_admin         -> exchange_rate.trade.requested
--   approved_for_contact  -> exchange_rate.trade.approved
--   rejected              -> exchange_rate.trade.rejected
--   completed             -> exchange_rate.trade.completed
--
-- This migration is safe for an already-running test/staging database:
-- legacy FX event aliases are canonicalized before the strict constraint is
-- restored, duplicate aliases are collapsed, and obsolete unsent lifecycle
-- events are retained as failed audit rows instead of being delivered late.
-- ============================================================

alter table public.customer_intent_notifications
  drop constraint if exists customer_intent_notifications_event_type_check;

-- If a partial rollout already produced a canonical row, keep it and remove
-- only the duplicate legacy alias before renaming the remaining legacy rows.
delete from public.customer_intent_notifications as legacy
using public.customer_intent_notifications as canonical
where legacy.id <> canonical.id
  and legacy.account_id = canonical.account_id
  and legacy.fx_trade_request_id = canonical.fx_trade_request_id
  and (
    (legacy.event_type = 'exchange_rate.trade.pending'
      and canonical.event_type = 'exchange_rate.trade.requested')
    or
    (legacy.event_type = 'exchange_rate.trade.approved_for_contact'
      and canonical.event_type = 'exchange_rate.trade.approved')
  );

update public.customer_intent_notifications
   set event_type = 'exchange_rate.trade.requested'
 where event_type = 'exchange_rate.trade.pending';

update public.customer_intent_notifications
   set event_type = 'exchange_rate.trade.approved'
 where event_type = 'exchange_rate.trade.approved_for_contact';

-- Never deliver an older lifecycle message after the authoritative trade has
-- already advanced. The row remains for auditability but leaves the queue.
update public.customer_intent_notifications as cin
   set status = 'failed',
       claim_token = null,
       claimed_at = null,
       last_error = 'SUPERSEDED_BY_TRADE_STATE:' || trade.status
  from public.exchange_trade_requests as trade
 where cin.fx_trade_request_id = trade.id
   and cin.account_id = trade.account_id
   and cin.status = 'pending'
   and (
     (cin.event_type = 'exchange_rate.trade.requested' and trade.status <> 'pending_admin')
     or
     (cin.event_type = 'exchange_rate.trade.approved' and trade.status <> 'approved_for_contact')
     or
     (cin.event_type = 'exchange_rate.trade.rejected' and trade.status <> 'rejected')
     or
     (cin.event_type = 'exchange_rate.trade.completed' and trade.status <> 'completed')
   );

alter table public.customer_intent_notifications
  add constraint customer_intent_notifications_event_type_check
  check (event_type in (
    'approved_and_applied',
    'rejected',
    'needs_clarification',
    'matched',
    'exchange_rate.trade.requested',
    'exchange_rate.trade.approved',
    'exchange_rate.trade.rejected',
    'exchange_rate.trade.completed'
  ));

-- Business status -> canonical business event adapter.
-- The trigger remains AFTER INSERT/UPDATE so the frozen trade snapshot and the
-- durable outbox event are committed atomically in the same transaction.
create or replace function public.enqueue_fx_trade_customer_lifecycle_event()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions
as $$
declare
  v_event_type text;
  v_change_request_id uuid;
begin
  if new.contact_id is null or new.conversation_id is null then
    return new;
  end if;

  -- A newer authoritative state supersedes any older unsent FX lifecycle
  -- event in the same transaction that records the state transition.
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    update public.customer_intent_notifications
       set status = 'failed',
           claim_token = null,
           claimed_at = null,
           last_error = 'SUPERSEDED_BY_TRADE_STATE:' || new.status
     where account_id = new.account_id
       and fx_trade_request_id = new.id
       and status = 'pending'
       and event_type in (
         'exchange_rate.trade.requested',
         'exchange_rate.trade.approved',
         'exchange_rate.trade.rejected',
         'exchange_rate.trade.completed'
       );
  end if;

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
    v_change_request_id := new.decision_change_request_id;
  end if;

  insert into public.customer_intent_notifications (
    account_id,
    intent_id,
    fx_trade_request_id,
    change_request_id,
    contact_id,
    conversation_id,
    event_type,
    message_text,
    status
  ) values (
    new.account_id,
    null,
    new.id,
    v_change_request_id,
    new.contact_id,
    new.conversation_id,
    v_event_type,
    '__FX_V2_RENDER_AT_DELIVERY__',
    'pending'
  )
  on conflict (account_id, fx_trade_request_id, event_type) do nothing;

  return new;
end;
$$;

revoke all on function public.enqueue_fx_trade_customer_lifecycle_event()
  from public, anon, authenticated;
