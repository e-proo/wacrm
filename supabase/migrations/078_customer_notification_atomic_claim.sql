-- Claim customer outcome notifications using the database clock and row locks.
-- This removes app/DB clock-skew races and prevents concurrent workers from
-- claiming the same notification.

create or replace function public.claim_customer_intent_notifications(
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
  claim_token uuid
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
              cin.claim_token
  )
  select c.id,
         c.contact_id,
         c.conversation_id,
         c.message_text,
         c.attempts,
         c.claim_token
  from claimed as c
  order by c.id;
$$;

revoke execute on function public.claim_customer_intent_notifications(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_customer_intent_notifications(uuid, uuid, integer)
  to service_role;
