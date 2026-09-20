-- ============================================================
-- 095_service_request_business_event_snapshots.sql
-- Make generic service_request.* events self-contained for projection.
--
-- The legacy notification adapter remains the producer during strangler
-- migration, but the new business event must freeze the facts required by
-- MessageContext so projectors never depend on mutable Change Request or
-- Services rows at delivery time.
-- ============================================================

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
  v_proposed_payload jsonb;
  v_dedupe_key text;
  v_decision text;
  v_service_id text;
  v_service_name text;
  v_customer_reason text;
  v_event_payload jsonb;
begin
  if new.fx_trade_request_id is not null then
    v_event_type := new.event_type;
    v_subject_type := 'fx_trade_request';
    v_subject_id := new.fx_trade_request_id::text;
    v_event_payload := jsonb_build_object(
      'legacy_event_type', new.event_type,
      'legacy_notification_id', new.id
    );
  else
    if new.change_request_id is not null then
      select cr.target_type, cr.execution_result, cr.proposed_payload
        into v_target_type, v_execution_result, v_proposed_payload
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

      v_decision := coalesce(
        nullif(v_execution_result ->> 'decision', ''),
        nullif(v_proposed_payload ->> 'decision', '')
      );
      v_service_id := nullif(v_proposed_payload ->> 'matched_service_id', '');
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
          'legacy_event_type', new.event_type,
          'legacy_notification_id', new.id,
          'decision', v_decision,
          'service_id', v_service_id,
          'service_name', v_service_name,
          'customer_reason', v_customer_reason
        )
      );
    else
      -- Coverage/FX native producers own their authoritative payloads. This
      -- fallback payload is used only when an older path produced the legacy
      -- row before a native event row existed.
      v_event_payload := jsonb_build_object(
        'legacy_event_type', new.event_type,
        'legacy_notification_id', new.id
      );
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
    coalesce(v_event_payload, '{}'::jsonb),
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
        contact_id = coalesce(beo.contact_id, excluded.contact_id),
        conversation_id = coalesce(beo.conversation_id, excluded.conversation_id),
        correlation_id = coalesce(beo.correlation_id, excluded.correlation_id),
        causation_id = coalesce(beo.causation_id, excluded.causation_id),
        payload = case
          when beo.event_type like 'service_request.%'
           and not (
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

revoke all on function public.mirror_legacy_customer_notification_to_business_outbox()
  from public, anon, authenticated;
