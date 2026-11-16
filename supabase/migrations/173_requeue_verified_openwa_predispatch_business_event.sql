-- Restore a customer outcome that was DEFINITIVELY denied by WACRM Pilot
-- before the OpenWA provider call. Never touch ambiguous/sent/sending rows.
-- The previously failed local message stays in the audit trail with its
-- outbound idempotency key cleared; the next send reserves a fresh message
-- with the same stable business-event key.
CREATE OR REPLACE FUNCTION public.requeue_verified_openwa_predispatch_business_event(
  p_account_id uuid,
  p_change_request_id uuid,
  p_actor_user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
DECLARE
  v_change public.change_requests%rowtype;
  v_event public.business_event_outbox%rowtype;
  v_message public.messages%rowtype;
  v_outcome_count integer;
  v_affected integer;
BEGIN
  IF p_account_id IS NULL OR p_change_request_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'BUSINESS_EVENT_REARM_INVALID_INPUT' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_change
    FROM public.change_requests cr
    WHERE cr.account_id=p_account_id AND cr.id=p_change_request_id FOR SHARE;
  IF NOT FOUND OR v_change.status <> 'executed' OR v_change.action_key <> 'coverage.offer.create'
    OR v_change.proposed_payload->>'source_task_id' IS NULL
    OR v_change.proposed_payload->>'source_task_target_id' IS NULL THEN
    RAISE EXCEPTION 'BUSINESS_EVENT_REARM_NOT_TASK_APPROVAL' USING ERRCODE='P0001';
  END IF;

  SELECT count(*) INTO v_outcome_count
    FROM public.business_event_outbox e
    WHERE e.account_id=p_account_id AND e.correlation_id=p_change_request_id::text
      AND e.event_type='coverage.offer.approved' AND e.event_version=1;
  IF v_outcome_count <> 1 THEN
    RAISE EXCEPTION 'BUSINESS_EVENT_REARM_NOT_UNIQUE' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_event
    FROM public.business_event_outbox e
    WHERE e.account_id=p_account_id AND e.correlation_id=p_change_request_id::text
      AND e.event_type='coverage.offer.approved' AND e.event_version=1
    FOR UPDATE;
  IF v_event.delivery_mode <> 'active' OR v_event.audience <> 'customer'
    OR v_event.channel <> 'whatsapp'
    OR v_event.status NOT IN ('failed','requires_reconciliation')
    OR v_event.claim_token IS NOT NULL
    OR v_event.local_message_id IS NULL
    OR v_event.contact_id IS NULL OR v_event.conversation_id IS NULL THEN
    RAISE EXCEPTION 'BUSINESS_EVENT_REARM_UNSAFE_STATE' USING ERRCODE='P0001';
  END IF;
  IF NOT (v_event.last_error LIKE 'OPENWA_PRE_DISPATCH_DENIED:%'
    OR v_event.last_error LIKE
      'رفض Pilot الإرسال: مستلم هذه المحادثة غير معتمد لنوع الإرسال automation%') THEN
    RAISE EXCEPTION 'BUSINESS_EVENT_REARM_NOT_PROVED_PREDISPATCH' USING ERRCODE='P0001';
  END IF;
  IF (v_change.execution_result->'offer'->>'id') IS DISTINCT FROM v_event.subject_id
    OR v_event.subject_type <> 'coverage_offer'
    OR (v_change.proposed_payload->>'contact_id') IS DISTINCT FROM v_event.contact_id::text
    OR (v_change.proposed_payload->>'conversation_id') IS DISTINCT FROM v_event.conversation_id::text THEN
    RAISE EXCEPTION 'BUSINESS_EVENT_REARM_SCOPE_MISMATCH' USING ERRCODE='P0001';
  END IF;

  SELECT * INTO v_message FROM public.messages m
    WHERE m.id=v_event.local_message_id AND m.conversation_id=v_event.conversation_id
      AND m.engine_idempotency_key='business-event-outbox:'||v_event.id::text
    FOR UPDATE;
  IF NOT FOUND OR v_message.sender_type <> 'bot'
    OR v_message.status <> 'failed' OR v_message.provider <> 'openwa'
    OR v_message.connection_id IS NULL
    OR v_message.provider_message_id IS NOT NULL OR v_message.message_id IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM public.conversations c
      JOIN public.whatsapp_connections wc ON wc.id=v_message.connection_id
      WHERE c.id=v_message.conversation_id AND c.account_id=p_account_id
        AND c.contact_id=v_event.contact_id AND wc.account_id=p_account_id
        AND wc.provider='openwa'
    ) THEN
    RAISE EXCEPTION 'BUSINESS_EVENT_REARM_TRANSPORT_NOT_PROVED' USING ERRCODE='P0001';
  END IF;

  UPDATE public.messages
    SET engine_idempotency_key=NULL
    WHERE id=v_message.id AND status='failed'
      AND message_id IS NULL AND provider_message_id IS NULL
      AND engine_idempotency_key='business-event-outbox:'||v_event.id::text;
  GET DIAGNOSTICS v_affected=ROW_COUNT;
  IF v_affected <> 1 THEN
    RAISE EXCEPTION 'BUSINESS_EVENT_REARM_CAS_LOST' USING ERRCODE='P0001';
  END IF;
  UPDATE public.business_event_outbox
    SET status='pending', claim_token=NULL, claimed_at=NULL,
        available_at=now(), last_error=NULL, local_message_id=NULL
    WHERE id=v_event.id AND account_id=p_account_id AND status=v_event.status
      AND local_message_id=v_message.id;
  GET DIAGNOSTICS v_affected=ROW_COUNT;
  IF v_affected <> 1 THEN
    RAISE EXCEPTION 'BUSINESS_EVENT_REARM_CAS_LOST' USING ERRCODE='P0001';
  END IF;
  PERFORM public.append_service_activity_event(
    p_account_id,'business_event',v_event.id,
    'business_event.predispatch_requeued','user',p_actor_user_id::text,
    jsonb_build_object('change_request_id',p_change_request_id,
                       'prior_message_id',v_message.id)
  );
  RETURN v_event.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.requeue_verified_openwa_predispatch_business_event(uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.requeue_verified_openwa_predispatch_business_event(uuid,uuid,uuid)
  TO service_role;

COMMENT ON FUNCTION public.requeue_verified_openwa_predispatch_business_event(uuid,uuid,uuid)
  IS 'Service-only, single-event safe requeue of documented OpenWA pre-dispatch denial. Requires prior explicit admin API review, preserves failed message and prevents ambiguous re-sends.';
