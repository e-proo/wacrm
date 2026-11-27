-- FIX-06: renewable durable receipt lease and exact returned-effect recovery.
-- Additive, no automatic data mutation at migration time; Meta and legacy unchanged.
ALTER TABLE public.whatsapp_webhook_event_receipts
 ADD COLUMN intake_recovered_at timestamptz,
 ADD COLUMN intake_recovered_from text,
 ADD CONSTRAINT openwa_intake_recovery_shape CHECK (
   (intake_recovered_at IS NULL AND intake_recovered_from IS NULL)
   OR (intake_recovered_at IS NOT NULL AND intake_recovered_from IS NOT NULL
    AND intake_state IS NOT DISTINCT FROM 'completed' AND processed_at IS NOT NULL
    AND intake_recovered_from IN ('processing_uncertain','lease_expired')
    AND intake_recovered_at>=processed_at AND intake_finished_at=intake_recovered_at));

-- Conservative proof of the exact *inbound* event. A visible source alone,
-- another receipt's observation, missing media, or a partial effect is not proof.
-- A closed historical epoch is accepted only if it covered the completed effect.
-- No content, credentials, native identifiers or delivery claims are returned.
CREATE FUNCTION public.openwa_returned_intake_evidence(p_id uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT e.returned_at
 FROM public.whatsapp_webhook_event_receipts r
 JOIN public.inbox_message_connection_observations o ON o.account_id=r.account_id AND o.connection_id=r.connection_id AND o.receipt_id=r.id AND o.provider='openwa' AND o.direction='inbound'
 JOIN public.inbox_canonical_messages cm ON cm.account_id=o.account_id AND cm.id=o.canonical_id AND cm.channel_id=o.channel_id
   AND cm.provider=o.provider AND cm.direction=o.direction AND cm.origin_connection_id=o.connection_id AND cm.origin_membership_id=o.membership_id AND cm.native_message_id=o.native_message_id
 JOIN public.inbox_canonical_effects e ON e.account_id=cm.account_id AND e.canonical_id=cm.id AND e.channel_id=cm.channel_id AND e.provider=cm.provider
 JOIN public.messages m ON m.id=cm.source_message_id AND m.conversation_id=cm.conversation_id AND m.connection_id=cm.origin_connection_id
   AND m.provider=cm.provider AND m.provider_message_id=cm.native_message_id AND m.sender_type='customer'
 JOIN public.inbox_message_memberships im ON im.account_id=cm.account_id AND im.message_id=cm.source_message_id AND im.conversation_id=cm.conversation_id
   AND im.channel_id=cm.channel_id AND im.connection_id=cm.origin_connection_id AND im.membership_id=cm.origin_membership_id
   AND im.provider=cm.provider AND im.evidence_kind='verified_current_ingress' AND im.evidence_ref=cm.id::text
 JOIN public.whatsapp_channels ch ON ch.account_id=cm.account_id AND ch.id=cm.channel_id AND ch.provider=cm.provider
 JOIN public.whatsapp_channel_memberships ep ON ep.account_id=r.account_id AND ep.id=o.membership_id AND ep.connection_id=r.connection_id AND ep.channel_id=o.channel_id AND ep.provider='openwa'
 JOIN public.inbox_native_namespace_proofs np ON np.account_id=r.account_id AND np.membership_id=ep.id AND np.connection_id=r.connection_id AND np.channel_id=o.channel_id AND np.namespace_key=cm.namespace_key
 WHERE r.id=p_id AND r.provider='openwa' AND r.intake_state='review' AND r.intake_canonical_mode=true
 AND r.intake_reason IN ('processing_uncertain','lease_expired') AND r.processing_error IS NULL AND r.processed_at IS NULL
 AND r.processing_started_at IS NULL AND r.intake_claim_token IS NOT NULL AND r.processing_token=r.intake_claim_token AND r.processing_attempts=1
 AND r.intake_ciphertext IS NOT NULL AND r.intake_recovered_at IS NULL
 -- Receipt-only settlement is historical proof, NOT authority to use a
 -- new credential or epoch. The exact epoch must cover the whole effect.
 AND ep.session_snapshot=r.intake_session AND ep.instance_snapshot IS NOT DISTINCT FROM r.intake_instance
 AND ch.identity_key='e164:'||regexp_replace(coalesce(r.intake_phone,''),'^[+]','')
 AND ep.evidence_kind='authenticated_openwa_status' AND ep.valid_from<=r.received_at
 AND (ep.valid_until>=e.returned_at OR (ep.valid_until IS NULL AND ep.is_primary))
 AND np.scope_kind='single_connection' AND np.engine='whatsapp-web.js' AND np.gateway_version IN ('0.29.1','0.32.1') AND np.verified_at<=r.received_at
 AND im.recorded_at<=e.returned_at
 AND e.state='returned' AND e.claimed_at>=r.intake_claimed_at AND e.returned_at>=e.claimed_at
 AND o.observed_at>=r.intake_claimed_at AND o.observed_at<=e.returned_at
 AND (m.content_type NOT IN ('image','video','audio','document','sticker') OR nullif(m.media_url,'') IS NOT NULL)
 AND (SELECT count(*) FROM public.inbox_message_connection_observations x WHERE x.account_id=r.account_id AND x.receipt_id=r.id)=1
 AND EXISTS(SELECT 1 FROM public.inbox_canonical_effect_stages s WHERE s.account_id=e.account_id AND s.canonical_id=e.canonical_id
    AND s.claim_token=e.claim_token AND s.stage_key='message_received' AND s.state='returned' AND s.finished_at<=e.returned_at)
 AND NOT EXISTS(SELECT 1 FROM public.inbox_canonical_effect_stages s WHERE s.account_id=e.account_id AND s.canonical_id=e.canonical_id AND (s.state<>'returned' OR s.claim_token IS DISTINCT FROM e.claim_token))
 AND NOT EXISTS(SELECT 1 FROM public.openwa_deferred_events d WHERE d.account_id=r.account_id AND d.connection_id=r.connection_id AND d.provider_event_id=r.provider_event_id)
 AND NOT EXISTS(SELECT 1 FROM public.inbox_canonical_intake_review q WHERE q.account_id=r.account_id AND q.connection_id=r.connection_id AND q.receipt_id=r.id)
$$;
REVOKE ALL ON FUNCTION public.openwa_returned_intake_evidence(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.openwa_returned_intake_evidence(uuid) TO service_role;

CREATE OR REPLACE FUNCTION wacrm_internal.openwa_intake_receipt_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.intake_state IS NULL THEN
  IF NEW.intake_state IS NOT NULL THEN RAISE EXCEPTION 'OPENWA_INTAKE_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
 OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id OR NEW.received_at IS DISTINCT FROM OLD.received_at
 OR NEW.intake_canonical_mode IS DISTINCT FROM OLD.intake_canonical_mode OR NEW.intake_digest IS DISTINCT FROM OLD.intake_digest
 OR NEW.intake_session IS DISTINCT FROM OLD.intake_session OR NEW.intake_instance IS DISTINCT FROM OLD.intake_instance
 OR NEW.intake_phone IS DISTINCT FROM OLD.intake_phone OR NEW.intake_credential_version IS DISTINCT FROM OLD.intake_credential_version
 THEN RAISE EXCEPTION 'OPENWA_INTAKE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 -- A recovered result is a receipt-only disposition, not another handler invocation.
 IF OLD.intake_state='review' AND NEW.intake_state='completed'
  AND OLD.intake_recovered_at IS NULL AND NEW.intake_recovered_at IS NOT NULL
  AND NEW.intake_recovered_from=OLD.intake_reason AND NEW.intake_reason IS NULL
  AND OLD.processing_started_at IS NULL AND NEW.processing_started_at IS NULL
  AND NEW.processed_at IS NOT NULL AND NEW.processed_at=public.openwa_returned_intake_evidence(OLD.id)
  AND NEW.intake_finished_at=NEW.intake_recovered_at AND NEW.intake_recovered_at>=NEW.processed_at
  AND NEW.intake_ciphertext IS NULL
  AND (to_jsonb(NEW)-ARRAY['intake_state','processed_at','intake_finished_at','intake_reason','intake_ciphertext','intake_recovered_at','intake_recovered_from'])
     =(to_jsonb(OLD)-ARRAY['intake_state','processed_at','intake_finished_at','intake_reason','intake_ciphertext','intake_recovered_at','intake_recovered_from'])
 THEN RETURN NEW; END IF;
 IF NEW.intake_recovered_at IS DISTINCT FROM OLD.intake_recovered_at OR NEW.intake_recovered_from IS DISTINCT FROM OLD.intake_recovered_from THEN
  RAISE EXCEPTION 'OPENWA_INTAKE_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 -- Renewal only extends the same live lease; no token, payload, mode, age
 -- origin, or attempt changes. An expired lease cannot be resurrected.
 IF OLD.intake_state='running' AND NEW.intake_state='running'
  AND OLD.processing_token=OLD.intake_claim_token AND OLD.processed_at IS NULL
  AND OLD.processing_started_at>=clock_timestamp()-interval '90 seconds'
  AND NEW.processing_started_at>OLD.processing_started_at
  AND NEW.processing_started_at<=clock_timestamp()
  AND NEW.processing_started_at<=OLD.intake_claimed_at+interval '5 minutes'
  AND (to_jsonb(NEW)-'processing_started_at')=(to_jsonb(OLD)-'processing_started_at')
 THEN RETURN NEW; END IF;
 IF OLD.intake_state='pending' AND NEW.intake_state='running' AND NEW.processing_token IS NOT NULL
  AND NEW.processing_started_at IS NOT NULL AND NEW.processing_attempts=1 AND NEW.processed_at IS NULL
  AND NEW.intake_claim_token=NEW.processing_token AND NEW.intake_claimed_at=NEW.processing_started_at AND NEW.intake_ciphertext IS NOT DISTINCT FROM OLD.intake_ciphertext THEN RETURN NEW; END IF;
 -- Only a proven completed deferred job may scrub a completed handoff's ciphertext.
 IF OLD.intake_state='completed' AND NEW.intake_state='completed' AND OLD.intake_ciphertext IS NOT NULL AND NEW.intake_ciphertext IS NULL
 AND (to_jsonb(NEW)-'intake_ciphertext')=(to_jsonb(OLD)-'intake_ciphertext')
 AND EXISTS(SELECT 1 FROM public.openwa_deferred_events d WHERE d.account_id=OLD.account_id AND d.connection_id=OLD.connection_id AND d.provider_event_id=OLD.provider_event_id AND d.event_kind='unresolved_identity' AND d.state='completed') THEN RETURN NEW; END IF;
 IF NEW.intake_claim_token IS DISTINCT FROM OLD.intake_claim_token OR NEW.intake_claimed_at IS DISTINCT FROM OLD.intake_claimed_at OR (NEW.intake_ciphertext IS DISTINCT FROM OLD.intake_ciphertext AND NOT (OLD.intake_state='running' AND NEW.intake_state='completed' AND NEW.intake_ciphertext IS NULL)) THEN RAISE EXCEPTION 'OPENWA_INTAKE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF OLD.intake_state='pending' AND NEW.intake_state='review' AND NEW.processing_token IS NULL AND NEW.processing_started_at IS NULL THEN RETURN NEW; END IF;
 IF OLD.intake_state='running' AND NEW.intake_state='running' AND OLD.processing_started_at IS NOT NULL
  AND OLD.processing_started_at>=clock_timestamp()-interval '90 seconds' AND OLD.processed_at IS NULL
  AND NEW.processing_started_at IS NULL AND NEW.processing_attempts=OLD.processing_attempts
  AND (NEW.processing_token IS NOT DISTINCT FROM OLD.processing_token OR (NEW.processing_token IS NULL AND NEW.processed_at IS NOT NULL))
  AND NEW.intake_ciphertext IS NOT DISTINCT FROM OLD.intake_ciphertext THEN RETURN NEW; END IF;
 IF OLD.intake_state='running' AND NEW.intake_state IN ('completed','review') AND NEW.processing_started_at IS NULL
  AND NEW.processed_at IS NOT DISTINCT FROM OLD.processed_at AND NEW.processing_attempts=OLD.processing_attempts
  AND NEW.processing_token IS NOT DISTINCT FROM OLD.processing_token THEN RETURN NEW; END IF;
 IF OLD.intake_state='review' AND NEW.intake_state='closed_unverified' AND NEW.processing_started_at IS NULL
  AND NEW.processed_at IS NOT DISTINCT FROM OLD.processed_at AND NEW.processing_token IS NOT DISTINCT FROM OLD.processing_token
  AND NEW.intake_ciphertext IS NOT DISTINCT FROM OLD.intake_ciphertext AND NEW.intake_reason IS NOT DISTINCT FROM OLD.intake_reason AND NEW.processing_attempts=OLD.processing_attempts THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'OPENWA_INTAKE_LEASE_FENCED' USING ERRCODE='55P03';
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.openwa_intake_receipt_fence() FROM PUBLIC,anon,authenticated,service_role;

-- Heartbeats retain the immutable original intake_claimed_at for latency
-- metrics. All existing 90-second receipt fences read processing_started_at.
CREATE FUNCTION public.openwa_renew_signed_intake(p_id uuid,p_token uuid,p_canonical boolean,p_lifecycle boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE r public.whatsapp_webhook_event_receipts%ROWTYPE; t timestamptz;
BEGIN
 IF p_token IS NULL OR p_canonical IS NULL OR p_lifecycle IS NULL THEN RETURN false; END IF;
 SELECT * INTO r FROM public.whatsapp_webhook_event_receipts WHERE id=p_id AND provider='openwa' AND intake_state='running' FOR UPDATE;
 IF NOT FOUND OR r.intake_claim_token IS DISTINCT FROM p_token OR r.processing_token IS DISTINCT FROM p_token
 OR NOT public.openwa_check_claimed_intake(p_id,p_token,p_canonical,p_lifecycle) THEN RETURN false; END IF;
 t=clock_timestamp();
 IF r.processing_started_at IS NULL OR r.processing_started_at<t-interval '90 seconds'
 OR t>r.intake_claimed_at+interval '5 minutes' OR t<=r.processing_started_at THEN RETURN false; END IF;
 UPDATE public.whatsapp_webhook_event_receipts SET processing_started_at=t WHERE id=r.id;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.openwa_renew_signed_intake(uuid,uuid,boolean,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.openwa_renew_signed_intake(uuid,uuid,boolean,boolean) TO service_role;

CREATE FUNCTION public.openwa_recover_returned_intake(p_account uuid,p_connection uuid,p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE r public.whatsapp_webhook_event_receipts%ROWTYPE; proof timestamptz; t timestamptz;
BEGIN
 SELECT * INTO r FROM public.whatsapp_webhook_event_receipts WHERE id=p_id AND account_id=p_account AND connection_id=p_connection AND provider='openwa' FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF r.intake_state='completed' AND r.intake_recovered_at IS NOT NULL THEN RETURN true; END IF;
 -- Lock the exact source row against concurrent deletion/media change. Proof
 -- tables are SELECT-only for service_role; keep their grants unchanged.
 -- Immutable historical evidence is rechecked by the receipt trigger.
 PERFORM 1 FROM public.inbox_message_connection_observations o
 JOIN public.inbox_canonical_messages cm ON cm.account_id=o.account_id AND cm.id=o.canonical_id
 JOIN public.inbox_canonical_effects e ON e.account_id=cm.account_id AND e.canonical_id=cm.id
 JOIN public.messages m ON m.id=cm.source_message_id
 JOIN public.inbox_message_memberships im ON im.account_id=cm.account_id AND im.message_id=cm.source_message_id
 JOIN public.whatsapp_channels ch ON ch.account_id=cm.account_id AND ch.id=cm.channel_id
 JOIN public.whatsapp_channel_memberships ep ON ep.account_id=o.account_id AND ep.id=o.membership_id
 JOIN public.inbox_native_namespace_proofs np ON np.account_id=ep.account_id AND np.membership_id=ep.id
 WHERE o.account_id=r.account_id AND o.connection_id=r.connection_id AND o.receipt_id=r.id
 FOR SHARE OF m;
 proof=public.openwa_returned_intake_evidence(r.id);
 IF proof IS NULL THEN RETURN false; END IF;
 t=clock_timestamp();
 UPDATE public.whatsapp_webhook_event_receipts SET intake_state='completed',processed_at=proof,
   intake_finished_at=t,intake_recovered_at=t,intake_recovered_from=r.intake_reason,intake_reason=NULL,intake_ciphertext=NULL
 WHERE id=r.id AND account_id=p_account AND connection_id=p_connection AND intake_state='review';
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.openwa_recover_returned_intake(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.openwa_recover_returned_intake(uuid,uuid,uuid) TO service_role;

-- Versioned entry point: applying the migration cannot activate recovery in
-- an already-running old worker. The existing claim routine stays unchanged.
CREATE FUNCTION public.openwa_claim_signed_intake_v2(p_canonical boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE candidate record;
BEGIN
 IF p_canonical IS NULL THEN RAISE EXCEPTION 'OPENWA_INTAKE_MODE_REQUIRED' USING ERRCODE='22023'; END IF;
 IF p_canonical THEN
  FOR candidate IN SELECT q.id,q.account_id,q.connection_id
    FROM public.whatsapp_webhook_event_receipts q
    WHERE q.intake_state='review' AND q.intake_canonical_mode=true
      AND public.openwa_returned_intake_evidence(q.id) IS NOT NULL
    ORDER BY q.received_at,q.id LIMIT 5 FOR UPDATE OF q SKIP LOCKED
  LOOP
   PERFORM public.openwa_recover_returned_intake(candidate.account_id,candidate.connection_id,candidate.id);
  END LOOP;
 END IF;
 -- Retain the single existing FIFO, route-binding and stale-claim pipeline.
 -- A stale running claim swept into review can be reconciled next tick.
 RETURN public.openwa_claim_signed_intake(p_canonical);
END $$;
REVOKE ALL ON FUNCTION public.openwa_claim_signed_intake_v2(boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.openwa_claim_signed_intake_v2(boolean) TO service_role;
