-- FIX-05: explicit disposition of old synchronous receipts with missing evidence.
-- Keep original token/error/timestamps and processed_at NULL. No delivery claim,
-- new proof, replay or backfill. All historical data remains unchanged by DDL.
ALTER TABLE public.whatsapp_webhook_event_receipts ADD COLUMN legacy_closed_at timestamptz, ADD COLUMN legacy_closed_by uuid;
ALTER TABLE public.whatsapp_webhook_event_receipts ADD CONSTRAINT openwa_legacy_receipt_disposition_shape CHECK (
 (legacy_closed_at IS NULL AND legacy_closed_by IS NULL) OR
 (legacy_closed_at IS NOT NULL AND legacy_closed_by IS NOT NULL AND provider='openwa' AND intake_state IS NULL AND processed_at IS NULL));
CREATE INDEX openwa_legacy_receipt_review_idx ON public.whatsapp_webhook_event_receipts(account_id,id)
 WHERE provider='openwa' AND intake_state IS NULL AND processed_at IS NULL;
CREATE FUNCTION wacrm_internal.openwa_legacy_disposition_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.legacy_closed_at IS NOT NULL THEN
  -- Also fences an older application binary's compare-and-set or finalizer.
  IF to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN RAISE EXCEPTION 'OPENWA_LEGACY_RECEIPT_CLOSED' USING ERRCODE='55P03'; END IF;
 ELSIF NEW.legacy_closed_at IS NOT NULL THEN
  IF (to_jsonb(OLD)-'legacy_closed_at'-'legacy_closed_by') IS DISTINCT FROM (to_jsonb(NEW)-'legacy_closed_at'-'legacy_closed_by')
    OR OLD.provider<>'openwa' OR OLD.intake_state IS NOT NULL OR OLD.processed_at IS NOT NULL
    OR greatest(OLD.received_at,coalesce(OLD.processing_started_at,OLD.received_at))>=clock_timestamp()-interval '10 minutes'
    OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=NEW.legacy_closed_by AND account_id=OLD.account_id AND account_role IN ('owner','admin'))
    OR EXISTS(SELECT 1 FROM public.openwa_deferred_events d WHERE d.account_id=OLD.account_id AND d.connection_id=OLD.connection_id AND d.provider_event_id=OLD.provider_event_id)
    OR EXISTS(SELECT 1 FROM public.inbox_message_connection_observations o WHERE o.account_id=OLD.account_id AND o.connection_id=OLD.connection_id AND o.receipt_id=OLD.id)
    OR EXISTS(SELECT 1 FROM public.inbox_canonical_intake_review q WHERE q.account_id=OLD.account_id AND q.connection_id=OLD.connection_id AND q.receipt_id=OLD.id)
  THEN RAISE EXCEPTION 'OPENWA_LEGACY_RECEIPT_NOT_ELIGIBLE' USING ERRCODE='55P03'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.openwa_legacy_disposition_fence() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER openwa_legacy_disposition_fence BEFORE UPDATE ON public.whatsapp_webhook_event_receipts FOR EACH ROW EXECUTE FUNCTION wacrm_internal.openwa_legacy_disposition_fence();
CREATE OR REPLACE FUNCTION public.openwa_enqueue_signed_intake(p_account uuid,p_connection uuid,p_event text,p_session text,p_instance text,
 p_credential_version timestamptz,p_canonical boolean,p_digest text,p_ciphertext text)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE c public.whatsapp_connections%ROWTYPE;r public.whatsapp_webhook_event_receipts%ROWTYPE;cv timestamptz; n bigint; bytes bigint;
BEGIN
 IF p_event IS NULL OR length(p_event) NOT BETWEEN 1 AND 255 OR p_session IS NULL OR length(p_session) NOT BETWEEN 1 AND 160
 OR (p_instance IS NOT NULL AND length(p_instance)>160) OR p_canonical IS NULL OR p_credential_version IS NULL
 OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 58 AND 50331776
 THEN RAISE EXCEPTION 'OPENWA_INTAKE_BAD_INPUT' USING ERRCODE='22023'; END IF;
 -- Serialize only account admission/cap accounting; no network work in lock.
 PERFORM pg_advisory_xact_lock(hashtextextended('openwa-intake:'||p_account::text,0));
 SELECT * INTO r FROM public.whatsapp_webhook_event_receipts WHERE account_id=p_account AND connection_id=p_connection AND provider='openwa' AND provider_event_id=p_event FOR UPDATE;
 SELECT * INTO c FROM public.whatsapp_connections WHERE account_id=p_account AND id=p_connection AND provider='openwa' AND archived_at IS NULL FOR SHARE;
 IF NOT FOUND OR c.session_id IS DISTINCT FROM p_session OR c.instance_id IS DISTINCT FROM p_instance THEN RETURN 'binding_changed'; END IF;
 SELECT updated_at INTO cv FROM public.whatsapp_connection_credentials WHERE account_id=p_account AND connection_id=p_connection AND provider='openwa'
 AND webhook_secret_encrypted IS NOT NULL FOR SHARE;
 IF NOT FOUND OR cv IS DISTINCT FROM p_credential_version THEN RETURN 'binding_changed'; END IF;
 IF r.id IS NOT NULL THEN
  IF r.intake_state IS NOT NULL THEN
   IF r.intake_digest IS DISTINCT FROM p_digest THEN RETURN 'conflict'; END IF;
   RETURN 'accepted_duplicate';
  END IF;
  -- Never adopt an unfinished synchronous receipt: external effects may have
  -- happened already. Gateway retries are not proof of no side effects.
  RETURN CASE WHEN r.legacy_closed_at IS NOT NULL THEN 'closed_unverified_duplicate' WHEN r.processed_at IS NOT NULL THEN 'completed_duplicate' ELSE 'legacy_busy' END;
 END IF;
 SELECT count(*),coalesce(sum(octet_length(intake_ciphertext)),0) INTO n,bytes
 FROM public.whatsapp_webhook_event_receipts WHERE account_id=p_account AND intake_state IS NOT NULL AND intake_ciphertext IS NOT NULL;
 IF n>=500 OR bytes+octet_length(p_ciphertext)>134217728 THEN RETURN 'capacity'; END IF;
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,
  intake_state,intake_canonical_mode,intake_ciphertext,intake_digest,intake_session,intake_instance,intake_phone,intake_credential_version)
 VALUES(p_account,p_connection,'openwa',p_event,clock_timestamp(),'pending',p_canonical,p_ciphertext,p_digest,p_session,p_instance,c.phone_identity,cv)
 ON CONFLICT(connection_id,provider,provider_event_id) DO NOTHING;
 IF NOT FOUND THEN RETURN 'legacy_busy'; END IF;
 RETURN 'accepted';
END $$;
CREATE OR REPLACE FUNCTION public.openwa_intake_health(p_account uuid,p_actor uuid,p_canonical boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=p_actor AND account_id=p_account AND account_role IN ('owner','admin'))
 THEN RAISE EXCEPTION 'INBOX_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('pending',count(*) FILTER(WHERE intake_state='pending'),
 'running',count(*) FILTER(WHERE intake_state='running'),'review',count(*) FILTER(WHERE intake_state='review'),
 'closed_unverified',count(*) FILTER(WHERE intake_state='closed_unverified'),
 'completed_24h',count(*) FILTER(WHERE intake_state='completed' AND intake_finished_at>=statement_timestamp()-interval '24 hours'),
 'mode_blocked',count(*) FILTER(WHERE intake_state='pending' AND intake_canonical_mode IS DISTINCT FROM p_canonical),
 'oldest_pending_seconds',coalesce(greatest(0,floor(extract(epoch FROM statement_timestamp()-min(received_at) FILTER(WHERE intake_state='pending')))),0),
 'oldest_running_seconds',coalesce(greatest(0,floor(extract(epoch FROM statement_timestamp()-min(intake_claimed_at) FILTER(WHERE intake_state='running')))),0),
 'retained_events',count(*) FILTER(WHERE intake_ciphertext IS NOT NULL),
 'retained_bytes',coalesce(sum(octet_length(intake_ciphertext)),0))
 INTO result FROM public.whatsapp_webhook_event_receipts WHERE account_id=p_account AND intake_state IS NOT NULL
 AND (intake_state<>'completed' OR intake_ciphertext IS NOT NULL OR intake_finished_at>=statement_timestamp()-interval '24 hours');
 RETURN result||jsonb_build_object(
 'legacy_unfinished',(SELECT count(*) FROM public.whatsapp_webhook_event_receipts WHERE account_id=p_account AND provider='openwa' AND intake_state IS NULL AND processed_at IS NULL AND legacy_closed_at IS NULL),
 'legacy_closed',(SELECT count(*) FROM public.whatsapp_webhook_event_receipts WHERE account_id=p_account AND provider='openwa' AND legacy_closed_at IS NOT NULL),
 'review_blocked',(SELECT count(*) FROM public.whatsapp_webhook_event_receipts q WHERE q.account_id=p_account AND q.intake_state='pending'
   AND EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts x WHERE x.account_id=q.account_id AND x.connection_id=q.connection_id AND x.intake_state='review')),
 'latency_sample',(SELECT jsonb_build_object('count',count(*),'avg_queue_ms',coalesce(round(avg(extract(epoch FROM intake_claimed_at-received_at)*1000)),0),
 'avg_processing_ms',coalesce(round(avg(extract(epoch FROM intake_finished_at-intake_claimed_at)*1000)),0),
 'max_processing_ms',coalesce(round(max(extract(epoch FROM intake_finished_at-intake_claimed_at)*1000)),0)) FROM (
 SELECT received_at,intake_claimed_at,intake_finished_at FROM public.whatsapp_webhook_event_receipts
 WHERE account_id=p_account AND intake_state='completed' AND intake_claimed_at IS NOT NULL AND intake_finished_at>=statement_timestamp()-interval '24 hours'
 ORDER BY intake_finished_at DESC,id LIMIT 1000) sample));
END $$;
CREATE OR REPLACE FUNCTION public.openwa_intake_review_page(p_account uuid,p_actor uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=p_actor AND account_id=p_account AND account_role IN ('owner','admin')) THEN RAISE EXCEPTION 'INBOX_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'OPENWA_INTAKE_LIMIT' USING ERRCODE='22023'; END IF;
 WITH page AS MATERIALIZED(SELECT id,connection_id,
  CASE WHEN intake_state IS NULL THEN CASE WHEN legacy_closed_at IS NULL THEN 'review' ELSE 'closed_unverified' END ELSE intake_state END intake_state,
  CASE WHEN intake_state IS NULL THEN 'legacy_payload_missing' ELSE intake_reason END intake_reason,
  received_at,CASE WHEN intake_state IS NULL THEN NULL ELSE intake_finished_at END intake_finished_at,
  coalesce(intake_closed_at,legacy_closed_at) intake_closed_at,coalesce(intake_canonical_mode,false) intake_canonical_mode,
  CASE WHEN intake_state IS NULL THEN legacy_closed_at IS NULL AND greatest(received_at,coalesce(processing_started_at,received_at))<statement_timestamp()-interval '10 minutes' ELSE intake_state='review' END can_close
  FROM public.whatsapp_webhook_event_receipts
  WHERE account_id=p_account AND provider='openwa' AND (intake_state IN ('review','closed_unverified') OR (intake_state IS NULL AND processed_at IS NULL)) AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT p_limit+1)
 SELECT jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('id',r.id,'connection_id',r.connection_id,'display_name',left(c.display_name,160),
 'state',r.intake_state,'reason',r.intake_reason,'received_at',r.received_at,'finished_at',r.intake_finished_at,'closed_at',r.intake_closed_at,'canonical',r.intake_canonical_mode,'can_close',r.can_close) ORDER BY r.id),'[]'::jsonb))
 INTO result FROM page r JOIN public.whatsapp_connections c ON c.account_id=p_account AND c.id=r.connection_id AND c.provider='openwa';
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.openwa_intake_close_unverified(p_account uuid,p_actor uuid,p_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE r public.whatsapp_webhook_event_receipts%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=p_actor AND account_id=p_account AND account_role IN ('owner','admin')) THEN RAISE EXCEPTION 'INBOX_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.whatsapp_webhook_event_receipts WHERE account_id=p_account AND id=p_id AND provider='openwa' FOR UPDATE;
 IF NOT FOUND THEN RETURN 'conflict'; END IF;
 IF r.intake_state IS NULL THEN
  IF r.legacy_closed_at IS NOT NULL THEN RETURN CASE WHEN r.legacy_closed_by=p_actor THEN 'closed_unverified' ELSE 'conflict' END; END IF;
  IF r.processed_at IS NOT NULL OR greatest(r.received_at,coalesce(r.processing_started_at,r.received_at))>=clock_timestamp()-interval '10 minutes'
   OR EXISTS(SELECT 1 FROM public.openwa_deferred_events d WHERE d.account_id=p_account AND d.connection_id=r.connection_id AND d.provider_event_id=r.provider_event_id)
   OR EXISTS(SELECT 1 FROM public.inbox_message_connection_observations o WHERE o.account_id=p_account AND o.connection_id=r.connection_id AND o.receipt_id=r.id)
   OR EXISTS(SELECT 1 FROM public.inbox_canonical_intake_review q WHERE q.account_id=p_account AND q.connection_id=r.connection_id AND q.receipt_id=r.id)
  THEN RETURN 'conflict'; END IF;
  UPDATE public.whatsapp_webhook_event_receipts SET legacy_closed_at=clock_timestamp(),legacy_closed_by=p_actor
   WHERE account_id=p_account AND id=p_id AND intake_state IS NULL AND processed_at IS NULL AND legacy_closed_at IS NULL;
  IF NOT FOUND THEN RETURN 'conflict'; END IF;
  RETURN 'closed_unverified';
 END IF;
 IF r.intake_state='closed_unverified' AND r.intake_closed_by=p_actor THEN RETURN 'closed_unverified'; END IF;
 IF r.intake_state IS DISTINCT FROM 'review' OR r.processing_started_at IS NOT NULL THEN RETURN 'conflict'; END IF;
 UPDATE public.whatsapp_webhook_event_receipts SET intake_state='closed_unverified',intake_closed_by=p_actor,intake_closed_at=clock_timestamp()
 WHERE account_id=p_account AND id=p_id AND intake_state='review';
 RETURN 'closed_unverified';
END $$;
