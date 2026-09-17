-- ============================================================
-- 088_unified_customer_business_event_claim.sql
-- Unify immediate customer-event delivery for service intents and FX V2.
--
-- The historical outbox table keeps its existing name for compatibility.
-- Migration 084 intentionally excluded FX rows from the legacy
-- claim_customer_intent_notifications() RPC because, at that point, only the
-- recovery worker knew how to render FX events. The application now has a
-- domain-aware renderer on the immediate approval path too, so expose a new
-- claim RPC that treats both sources as first-class business events.
--
-- The legacy RPC is left untouched for backwards compatibility.
-- ============================================================

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

comment on function public.claim_customer_business_notifications(uuid, uuid, integer) is
  'Atomically claims due customer business-event notifications from either service intents or FX V2 trade requests for immediate delivery or recovery processing.';
