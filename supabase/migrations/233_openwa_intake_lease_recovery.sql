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
   AND m.provider=cm.provider AND m.provider_message_id=cm.native_message_id AND m.sender_type='contact'
 JOIN public.whatsapp_connections c ON c.account_id=r.account_id AND c.id=r.connection_id AND c.provider='openwa' AND c.archived_at IS NULL
 JOIN public.whatsapp_connection_credentials k ON k.account_id=r.account_id AND k.connection_id=r.connection_id AND k.provider='openwa'
 JOIN public.whatsapp_channel_memberships ep ON ep.account_id=r.account_id AND ep.id=o.membership_id AND ep.connection_id=r.connection_id AND ep.channel_id=o.channel_id AND ep.provider='openwa'
 JOIN public.inbox_native_namespace_proofs np ON np.account_id=r.account_id AND np.membership_id=ep.id AND np.connection_id=r.connection_id AND np.channel_id=o.channel_id AND np.namespace_key=cm.namespace_key
 WHERE r.id=p_id AND r.provider='openwa' AND r.intake_state='review' AND r.intake_canonical_mode=true
 AND r.intake_reason IN ('processing_uncertain','lease_expired') AND r.processing_error IS NULL AND r.processed_at IS NULL
 AND r.processing_started_at IS NULL AND r.intake_claim_token IS NOT NULL AND r.processing_token=r.intake_claim_token AND r.processing_attempts=1
 AND r.intake_ciphertext IS NOT NULL AND r.intake_recovered_at IS NULL
 AND c.status IN ('ready','connected') AND c.session_id=r.intake_session AND c.instance_id IS NOT DISTINCT FROM r.intake_instance
 AND c.phone_identity IS NOT DISTINCT FROM r.intake_phone AND k.updated_at=r.intake_credential_version
 AND ep.valid_until IS NULL AND ep.is_primary AND ep.valid_from<=r.received_at
 AND np.scope_kind='single_connection' AND np.engine=c.engine AND np.gateway_version IN ('0.29.1','0.32.1')
 AND e.state='returned' AND e.claimed_at>=r.intake_claimed_at AND e.returned_at>=e.claimed_at
 AND o.observed_at>=r.intake_claimed_at AND o.observed_at<=e.returned_at
 AND (m.content_type NOT IN ('image','video','audio','document','sticker') OR nullif(m.media_url,'') IS NOT NULL)
 AND public.inbox_validate_canonical_route(r.account_id,cm.conversation_id,cm.source_message_id,r.connection_id)
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
 -- Lock the matching proof graph before finalizing. Use the same receipt-first
 -- order as the canonical observation path. The trigger rechecks the proof.
 PERFORM 1 FROM public.inbox_message_connection_observations o
 JOIN public.inbox_canonical_messages cm ON cm.account_id=o.account_id AND cm.id=o.canonical_id
 JOIN public.inbox_canonical_effects e ON e.account_id=cm.account_id AND e.canonical_id=cm.id
 JOIN public.messages m ON m.id=cm.source_message_id
 JOIN public.whatsapp_connections c ON c.account_id=r.account_id AND c.id=r.connection_id
 JOIN public.whatsapp_connection_credentials k ON k.account_id=r.account_id AND k.connection_id=r.connection_id AND k.provider='openwa'
 JOIN public.whatsapp_channel_memberships ep ON ep.account_id=o.account_id AND ep.id=o.membership_id
 JOIN public.inbox_native_namespace_proofs np ON np.account_id=ep.account_id AND np.membership_id=ep.id
 WHERE o.account_id=r.account_id AND o.connection_id=r.connection_id AND o.receipt_id=r.id
 FOR SHARE OF o,cm,e,m,c,k,ep,np;
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

CREATE OR REPLACE FUNCTION public.openwa_claim_signed_intake(p_canonical boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE r public.whatsapp_webhook_event_receipts%ROWTYPE; c public.whatsapp_connections%ROWTYPE; cv timestamptz; tok uuid; candidate record;
BEGIN
 IF p_canonical IS NULL THEN RAISE EXCEPTION 'OPENWA_INTAKE_MODE_REQUIRED' USING ERRCODE='22023'; END IF;
 -- Crash after finalization: complete without replay. Crash before confirmed
 -- finalization: preserve ciphertext and review, NEVER reclaim the handler.
 WITH stale AS (SELECT id FROM public.whatsapp_webhook_event_receipts WHERE intake_state='running'
  AND (processing_started_at IS NULL OR processing_started_at<clock_timestamp()-interval '90 seconds')
  ORDER BY processing_started_at NULLS FIRST,id LIMIT 20 FOR UPDATE SKIP LOCKED)
 UPDATE public.whatsapp_webhook_event_receipts r0 SET
  intake_state=CASE WHEN processed_at IS NOT NULL AND processing_error IS NULL THEN 'completed' ELSE 'review' END,
  intake_ciphertext=CASE WHEN processed_at IS NOT NULL AND processing_error IS NULL AND NOT EXISTS(SELECT 1 FROM public.openwa_deferred_events d WHERE d.account_id=r0.account_id AND d.connection_id=r0.connection_id AND d.provider_event_id=r0.provider_event_id AND d.event_kind='unresolved_identity' AND d.state<>'completed') AND NOT EXISTS(SELECT 1 FROM public.inbox_canonical_intake_review q WHERE q.account_id=r0.account_id AND q.connection_id=r0.connection_id AND q.receipt_id=r0.id) THEN NULL ELSE intake_ciphertext END,
  intake_finished_at=clock_timestamp(),intake_reason=CASE WHEN processed_at IS NOT NULL AND processing_error IS NULL THEN NULL ELSE 'lease_expired' END,
  processing_started_at=NULL FROM stale WHERE r0.id=stale.id;
 -- Only complete exact, already-returned canonical receipts; never call the
 -- business handler again. Invalid evidence remains in review.
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
 -- Single oldest event per connection, even across modes; a mode mismatch
 -- blocks newer events on that route until the operator drains the old mode.
 SELECT q.* INTO r FROM public.whatsapp_webhook_event_receipts q WHERE q.intake_state='pending' AND q.intake_canonical_mode=p_canonical
 AND NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts x WHERE x.account_id=q.account_id AND x.connection_id=q.connection_id AND x.intake_state IN ('running','review'))
 AND NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts x WHERE x.account_id=q.account_id AND x.connection_id=q.connection_id AND x.intake_state='pending' AND (x.received_at,x.id)<(q.received_at,q.id))
 ORDER BY q.received_at,q.id LIMIT 1 FOR UPDATE OF q SKIP LOCKED;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','idle'); END IF;
 -- Receipt-first lock matches the existing canonical processing path.
 SELECT * INTO c FROM public.whatsapp_connections WHERE account_id=r.account_id AND id=r.connection_id AND provider='openwa' AND archived_at IS NULL FOR SHARE;
 IF NOT FOUND OR c.session_id IS DISTINCT FROM r.intake_session OR c.instance_id IS DISTINCT FROM r.intake_instance OR c.phone_identity IS DISTINCT FROM r.intake_phone
 THEN
  UPDATE public.whatsapp_webhook_event_receipts SET intake_state='review',intake_reason='binding_changed',intake_finished_at=clock_timestamp() WHERE id=r.id;
  RETURN jsonb_build_object('state','review');
 END IF;
 SELECT updated_at INTO cv FROM public.whatsapp_connection_credentials WHERE account_id=r.account_id AND connection_id=r.connection_id AND provider='openwa' FOR SHARE;
 IF NOT FOUND OR cv IS DISTINCT FROM r.intake_credential_version THEN
  UPDATE public.whatsapp_webhook_event_receipts SET intake_state='review',intake_reason='binding_changed',intake_finished_at=clock_timestamp() WHERE id=r.id;
  RETURN jsonb_build_object('state','review');
 END IF;
 tok=gen_random_uuid();
 r.intake_claimed_at=clock_timestamp();
 UPDATE public.whatsapp_webhook_event_receipts SET intake_state='running',intake_claim_token=tok,processing_token=tok,processing_started_at=r.intake_claimed_at,intake_claimed_at=r.intake_claimed_at,processing_attempts=1
 WHERE id=r.id AND intake_state='pending';
 RETURN jsonb_build_object('state','claimed','id',r.id,'account_id',r.account_id,'connection_id',r.connection_id,'event_id',r.provider_event_id,
  'session_id',r.intake_session,'instance_id',r.intake_instance,'canonical',r.intake_canonical_mode,'token',tok,'ciphertext',r.intake_ciphertext,'digest',r.intake_digest);
END $$;
