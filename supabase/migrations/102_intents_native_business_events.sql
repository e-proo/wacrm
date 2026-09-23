-- ============================================================
-- 102_intents_native_business_events.sql
-- Native atomic Business Event producer for customer intent decisions.
--
-- The legacy customer_intent_notifications row remains the active rollback
-- path during strangler migration. This trigger creates the canonical shadow
-- event in the SAME transaction as the authoritative customer_intents status
-- mutation; the later legacy notification insert links itself to the same
-- event through the shared dedupe key.
-- ============================================================

create or replace function public.enqueue_service_intent_business_event_shadow()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_event_type text;
  v_dedupe_key text;
  v_proposed_payload jsonb := '{}'::jsonb;
  v_decision text;
  v_service_id text;
  v_service_name text;
  v_customer_reason text;
  v_event_payload jsonb;
begin
  if tg_op <> 'UPDATE' or new.status is not distinct from old.status then
    return new;
  end if;

  v_event_type := case new.status
    when 'fulfilled' then 'service_request.approved'
    when 'rejected' then 'service_request.rejected'
    when 'matched' then 'service_request.matched'
    when 'clarifying' then 'service_request.needs_clarification'
    else null
  end;

  if v_event_type is null then
    return new;
  end if;

  if new.change_request_id is not null then
    select coalesce(cr.proposed_payload, '{}'::jsonb)
      into v_proposed_payload
      from public.change_requests as cr
     where cr.account_id = new.account_id
       and cr.id = new.change_request_id;
  end if;

  v_decision := coalesce(
    nullif(v_proposed_payload ->> 'decision', ''),
    case new.status
      when 'fulfilled' then 'fulfilled'
      when 'rejected' then 'rejected'
      when 'matched' then 'matched'
      when 'clarifying' then 'clarifying'
      else null
    end
  );
  v_service_id := coalesce(
    nullif(v_proposed_payload ->> 'matched_service_id', ''),
    new.matched_service_id::text
  );
  v_customer_reason := nullif(v_proposed_payload ->> 'customer_reason', '');

  if v_service_id is not null then
    select nullif(s.name, '')
      into v_service_name
      from public.services as s
     where s.account_id = new.account_id
       and s.id::text = v_service_id
     limit 1;
  end if;

  v_event_payload := jsonb_strip_nulls(
    jsonb_build_object(
      'decision', v_decision,
      'service_id', v_service_id,
      'service_name', v_service_name,
      'customer_reason', v_customer_reason
    )
  );

  v_dedupe_key :=
    v_event_type || ':v1:service_intent:' || new.id::text;

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
    'service_intent',
    new.id::text,
    'customer',
    'whatsapp',
    new.contact_id,
    new.conversation_id,
    new.change_request_id::text,
    new.id::text,
    v_event_payload,
    'shadow',
    'pending',
    null,
    v_dedupe_key
  )
  on conflict (account_id, dedupe_key) do update
    set contact_id = coalesce(beo.contact_id, excluded.contact_id),
        conversation_id = coalesce(beo.conversation_id, excluded.conversation_id),
        correlation_id = coalesce(beo.correlation_id, excluded.correlation_id),
        causation_id = coalesce(beo.causation_id, excluded.causation_id),
        payload = case
          when not (
            beo.payload ? 'decision'
            or beo.payload ? 'service_id'
            or beo.payload ? 'customer_reason'
          )
            then excluded.payload
          else beo.payload
        end;

  return new;
end;
$$;

revoke execute on function public.enqueue_service_intent_business_event_shadow()
  from public, anon, authenticated;

drop trigger if exists customer_intents_business_event_shadow
  on public.customer_intents;

create trigger customer_intents_business_event_shadow
  after update of status on public.customer_intents
  for each row
  execute function public.enqueue_service_intent_business_event_shadow();

comment on function public.enqueue_service_intent_business_event_shadow() is
  'Atomically creates canonical service_request.* shadow events from authoritative customer_intents status transitions. Legacy notification rows later attach by the same dedupe key during strangler migration.';
