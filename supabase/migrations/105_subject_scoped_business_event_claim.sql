-- ============================================================
-- 105_subject_scoped_business_event_claim.sql
-- Add an additive subject-scoped active Business Event claim boundary.
--
-- The existing claim_business_event_delivery(...) RPC remains unchanged for
-- rolling compatibility and worker-wide draining. This v2 form lets request
-- handlers opportunistically flush ONLY the subject they just mutated while
-- preserving the correlation ordering rule introduced in migration 101.
-- ============================================================

create or replace function public.claim_business_event_delivery_v2(
  p_account_id uuid,
  p_correlation_id text default null,
  p_subject_type text default null,
  p_subject_id text default null,
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
      and (
        (p_subject_type is null and p_subject_id is null)
        or (
          p_subject_type is not null
          and p_subject_id is not null
          and beo.subject_type = p_subject_type
          and beo.subject_id = p_subject_id
        )
      )
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
        (p_subject_type is null and p_subject_id is null)
        or (
          p_subject_type is not null
          and p_subject_id is not null
          and beo.subject_type = p_subject_type
          and beo.subject_id = p_subject_id
        )
      )
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

revoke execute on function public.claim_business_event_delivery_v2(
  uuid, text, text, text, integer
) from public, anon, authenticated;

grant execute on function public.claim_business_event_delivery_v2(
  uuid, text, text, text, integer
) to service_role;
