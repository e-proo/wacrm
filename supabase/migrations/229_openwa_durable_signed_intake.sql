-- FIX-04: durable signed intake uses the existing receipt ledger. No parallel
-- CRM pipeline. Acknowledgement means persisted, not business completion.
-- Existing synchronous receipts and Meta are unchanged; no data backfill.
ALTER TABLE public.whatsapp_webhook_event_receipts
 ADD COLUMN intake_state text,
 ADD COLUMN intake_canonical_mode boolean,
 ADD COLUMN intake_ciphertext text,
 ADD COLUMN intake_digest text,
 ADD COLUMN intake_session text,
 ADD COLUMN intake_instance text,
 ADD COLUMN intake_phone text,
 ADD COLUMN intake_credential_version timestamptz,
 ADD COLUMN intake_finished_at timestamptz,
 ADD COLUMN intake_reason text,
 ADD COLUMN intake_closed_by uuid,
 ADD COLUMN intake_claim_token uuid,
 ADD COLUMN intake_closed_at timestamptz;
ALTER TABLE public.whatsapp_webhook_event_receipts ADD CONSTRAINT openwa_durable_intake_shape CHECK (
 (intake_state IS NULL AND intake_canonical_mode IS NULL AND intake_ciphertext IS NULL AND intake_digest IS NULL AND intake_session IS NULL AND intake_instance IS NULL AND intake_phone IS NULL AND intake_credential_version IS NULL AND intake_finished_at IS NULL AND intake_reason IS NULL AND intake_closed_by IS NULL AND intake_claim_token IS NULL AND intake_closed_at IS NULL)
 OR (intake_state IS NOT NULL AND provider='openwa' AND intake_state IN ('pending','running','completed','review','closed_unverified')
 AND intake_canonical_mode IS NOT NULL AND intake_digest IS NOT NULL AND intake_digest ~ '^[0-9a-f]{64}$'
 AND intake_session IS NOT NULL AND length(intake_session) BETWEEN 1 AND 160 AND intake_credential_version IS NOT NULL
 AND (intake_ciphertext IS NULL OR octet_length(intake_ciphertext) BETWEEN 58 AND 50331776)
 AND ((intake_state='completed' AND intake_ciphertext IS NULL AND processed_at IS NOT NULL)
   OR (intake_state<>'completed' AND intake_ciphertext IS NOT NULL))
 AND ((intake_state='pending' AND intake_claim_token IS NULL AND processing_attempts=0 AND processing_token IS NULL AND processing_started_at IS NULL AND processed_at IS NULL)
   OR (intake_state='running' AND intake_claim_token IS NOT NULL AND processing_attempts=1)
   OR (intake_state IN ('completed','review','closed_unverified') AND processing_started_at IS NULL))
 AND ((intake_state='closed_unverified' AND intake_closed_at IS NOT NULL) OR (intake_state<>'closed_unverified' AND intake_closed_at IS NULL))
 AND ((intake_state IN ('pending','running') AND intake_finished_at IS NULL AND intake_reason IS NULL AND intake_closed_by IS NULL)
   OR (intake_state IN ('completed','review') AND intake_finished_at IS NOT NULL AND intake_closed_by IS NULL)
   OR (intake_state='closed_unverified' AND intake_finished_at IS NOT NULL AND intake_closed_by IS NOT NULL AND intake_reason='operator_closed_unverified'))
 AND (intake_reason IS NULL OR intake_reason IN ('binding_changed','processing_uncertain','lease_expired','payload_unavailable','operator_closed_unverified'))
 ));
CREATE INDEX openwa_intake_pending_idx ON public.whatsapp_webhook_event_receipts(intake_canonical_mode,received_at,id) WHERE intake_state='pending';
CREATE INDEX openwa_intake_running_idx ON public.whatsapp_webhook_event_receipts(processing_started_at,id) WHERE intake_state='running';
CREATE INDEX openwa_intake_account_idx ON public.whatsapp_webhook_event_receipts(account_id,intake_state,received_at,id) WHERE intake_state IS NOT NULL;
CREATE INDEX openwa_intake_route_pending_idx ON public.whatsapp_webhook_event_receipts(account_id,connection_id,received_at,id) WHERE intake_state='pending';
CREATE UNIQUE INDEX openwa_intake_one_running_route ON public.whatsapp_webhook_event_receipts(account_id,connection_id) WHERE intake_state='running';
-- Old application versions must never take a queued receipt lease through
-- the synchronous compare-and-set. Existing normal/deferred finalizers may
-- finish only the exact running lease (the deferred finalizer clears token).
CREATE FUNCTION wacrm_internal.openwa_intake_receipt_fence() RETURNS trigger
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
 IF OLD.intake_state='pending' AND NEW.intake_state='running' AND NEW.processing_token IS NOT NULL
  AND NEW.processing_started_at IS NOT NULL AND NEW.processing_attempts=1 AND NEW.processed_at IS NULL
  AND NEW.intake_claim_token=NEW.processing_token AND NEW.intake_ciphertext IS NOT DISTINCT FROM OLD.intake_ciphertext THEN RETURN NEW; END IF;
 IF NEW.intake_claim_token IS DISTINCT FROM OLD.intake_claim_token OR (NEW.intake_ciphertext IS DISTINCT FROM OLD.intake_ciphertext AND NOT (OLD.intake_state='running' AND NEW.intake_state='completed' AND NEW.intake_ciphertext IS NULL)) THEN RAISE EXCEPTION 'OPENWA_INTAKE_IMMUTABLE' USING ERRCODE='23514'; END IF;
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
  AND NEW.intake_ciphertext IS NOT DISTINCT FROM OLD.intake_ciphertext AND NEW.processing_attempts=OLD.processing_attempts THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'OPENWA_INTAKE_LEASE_FENCED' USING ERRCODE='55P03';
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.openwa_intake_receipt_fence() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER openwa_intake_receipt_fence BEFORE UPDATE ON public.whatsapp_webhook_event_receipts
 FOR EACH ROW EXECUTE FUNCTION wacrm_internal.openwa_intake_receipt_fence();

-- The application calls this ONLY after HMAC verification. Credential version
-- is captured from the exact credential row used to authenticate the body.
CREATE FUNCTION public.openwa_enqueue_signed_intake(p_account uuid,p_connection uuid,p_event text,p_session text,p_instance text,
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
  RETURN CASE WHEN r.processed_at IS NOT NULL THEN 'completed_duplicate' ELSE 'legacy_busy' END;
 END IF;
 SELECT count(*),coalesce(sum(octet_length(intake_ciphertext)),0) INTO n,bytes
 FROM public.whatsapp_webhook_event_receipts WHERE account_id=p_account AND intake_state IN ('pending','running','review','closed_unverified');
 IF n>=500 OR bytes+octet_length(p_ciphertext)>134217728 THEN RETURN 'capacity'; END IF;
 INSERT INTO public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,provider_event_id,received_at,
  intake_state,intake_canonical_mode,intake_ciphertext,intake_digest,intake_session,intake_instance,intake_phone,intake_credential_version)
 VALUES(p_account,p_connection,'openwa',p_event,clock_timestamp(),'pending',p_canonical,p_ciphertext,p_digest,p_session,p_instance,c.phone_identity,cv)
 ON CONFLICT(connection_id,provider,provider_event_id) DO NOTHING;
 IF NOT FOUND THEN RETURN 'legacy_busy'; END IF;
 RETURN 'accepted';
END $$;
REVOKE ALL ON FUNCTION public.openwa_enqueue_signed_intake(uuid,uuid,text,text,text,timestamptz,boolean,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.openwa_enqueue_signed_intake(uuid,uuid,text,text,text,timestamptz,boolean,text,text) TO service_role;

CREATE FUNCTION public.openwa_claim_signed_intake(p_canonical boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE r public.whatsapp_webhook_event_receipts%ROWTYPE; c public.whatsapp_connections%ROWTYPE; cv timestamptz; tok uuid;
BEGIN
 IF p_canonical IS NULL THEN RAISE EXCEPTION 'OPENWA_INTAKE_MODE_REQUIRED' USING ERRCODE='22023'; END IF;
 -- Crash after finalization: complete without replay. Crash before confirmed
 -- finalization: preserve ciphertext and review, NEVER reclaim the handler.
 WITH stale AS (SELECT id FROM public.whatsapp_webhook_event_receipts WHERE intake_state='running'
  AND (processing_started_at IS NULL OR processing_started_at<clock_timestamp()-interval '90 seconds')
  ORDER BY processing_started_at NULLS FIRST,id LIMIT 20 FOR UPDATE SKIP LOCKED)
 UPDATE public.whatsapp_webhook_event_receipts r0 SET
  intake_state=CASE WHEN processed_at IS NOT NULL AND processing_error IS NULL THEN 'completed' ELSE 'review' END,
  intake_ciphertext=CASE WHEN processed_at IS NOT NULL AND processing_error IS NULL THEN NULL ELSE intake_ciphertext END,
  intake_finished_at=clock_timestamp(),intake_reason=CASE WHEN processed_at IS NOT NULL AND processing_error IS NULL THEN NULL ELSE 'lease_expired' END,
  processing_started_at=NULL FROM stale WHERE r0.id=stale.id;
 -- Single oldest event per connection, even across modes; a mode mismatch
 -- blocks newer events on that route until the operator drains the old mode.
 SELECT q.* INTO r FROM public.whatsapp_webhook_event_receipts q WHERE q.intake_state='pending' AND q.intake_canonical_mode=p_canonical
 AND NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts x WHERE x.account_id=q.account_id AND x.connection_id=q.connection_id AND x.intake_state='running')
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
 UPDATE public.whatsapp_webhook_event_receipts SET intake_state='running',intake_claim_token=tok,processing_token=tok,processing_started_at=clock_timestamp(),processing_attempts=1
 WHERE id=r.id AND intake_state='pending';
 RETURN jsonb_build_object('state','claimed','id',r.id,'account_id',r.account_id,'connection_id',r.connection_id,'event_id',r.provider_event_id,
  'session_id',r.intake_session,'instance_id',r.intake_instance,'canonical',r.intake_canonical_mode,'token',tok,'ciphertext',r.intake_ciphertext,'digest',r.intake_digest);
END $$;
REVOKE ALL ON FUNCTION public.openwa_claim_signed_intake(boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.openwa_claim_signed_intake(boolean) TO service_role;

CREATE FUNCTION public.openwa_finish_signed_intake(p_id uuid,p_token uuid,p_reason text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE r public.whatsapp_webhook_event_receipts%ROWTYPE; result text;
BEGIN
 IF p_token IS NULL OR (p_reason IS NOT NULL AND p_reason NOT IN ('processing_uncertain','payload_unavailable')) THEN RAISE EXCEPTION 'OPENWA_INTAKE_BAD_FINISH' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM public.whatsapp_webhook_event_receipts WHERE id=p_id AND provider='openwa' AND intake_state='running' FOR UPDATE;
 IF NOT FOUND THEN RETURN 'conflict'; END IF;
 -- Deferred handoff may clear the receipt token; the immutable claim token still binds the worker.
 IF r.intake_claim_token IS DISTINCT FROM p_token THEN RETURN 'conflict'; END IF;
 result=CASE WHEN r.processed_at IS NOT NULL AND r.processing_error IS NULL THEN 'completed' ELSE 'review' END;
 UPDATE public.whatsapp_webhook_event_receipts SET intake_state=result,intake_finished_at=clock_timestamp(),
 intake_ciphertext=CASE WHEN result='completed' THEN NULL ELSE intake_ciphertext END,
 intake_reason=CASE WHEN result='completed' THEN NULL ELSE coalesce(p_reason,'processing_uncertain') END,processing_started_at=NULL WHERE id=p_id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.openwa_finish_signed_intake(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.openwa_finish_signed_intake(uuid,uuid,text) TO service_role;

-- Preserve mode across the existing specialized LID/ACK handoff. Old
-- workers must not claim pinned jobs. Unpinned historical jobs retain their
-- existing contract; drain them before changing the canonical mode.
ALTER TABLE public.openwa_deferred_events ADD COLUMN intake_canonical_mode boolean;
CREATE FUNCTION wacrm_internal.openwa_pin_deferred_intake_mode() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.intake_canonical_mode IS DISTINCT FROM OLD.intake_canonical_mode THEN RAISE EXCEPTION 'OPENWA_DEFERRED_MODE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT intake_canonical_mode INTO NEW.intake_canonical_mode FROM public.whatsapp_webhook_event_receipts
   WHERE account_id=NEW.account_id AND connection_id=NEW.connection_id AND provider='openwa' AND provider_event_id=NEW.provider_event_id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.openwa_pin_deferred_intake_mode() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER openwa_pin_deferred_intake_mode BEFORE INSERT OR UPDATE OF intake_canonical_mode ON public.openwa_deferred_events
 FOR EACH ROW EXECUTE FUNCTION wacrm_internal.openwa_pin_deferred_intake_mode();

CREATE FUNCTION public.openwa_intake_health(p_account uuid,p_actor uuid,p_canonical boolean) RETURNS jsonb
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
 'oldest_running_seconds',coalesce(greatest(0,floor(extract(epoch FROM statement_timestamp()-min(processing_started_at) FILTER(WHERE intake_state='running')))),0))
 INTO result FROM public.whatsapp_webhook_event_receipts WHERE account_id=p_account AND intake_state IS NOT NULL
 AND (intake_state<>'completed' OR intake_finished_at>=statement_timestamp()-interval '24 hours');
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.openwa_intake_health(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.openwa_intake_health(uuid,uuid,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_openwa_deferred_events(p_limit integer DEFAULT 5)
RETURNS TABLE (
  job_id uuid,
  account_id uuid,
  connection_id uuid,
  session_id text,
  own_phone_identity text,
  instance_id text,
  event_kind text,
  provider_message_id text,
  native_chat_id text,
  verified_phone text,
  verification_source text,
  verified_at timestamptz,
  normalized_payload jsonb,
  attempt_count integer,
  lease_token uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>10 THEN
    RAISE EXCEPTION 'Invalid deferred worker batch' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT q.id FROM public.openwa_deferred_events q
    WHERE q.intake_canonical_mode IS NULL AND ((q.state='pending' AND q.next_attempt_at<=now())
       OR (q.state='leased' AND q.lease_until<now()))
    ORDER BY q.next_attempt_at,q.created_at
    FOR UPDATE OF q SKIP LOCKED LIMIT p_limit
  )
  UPDATE public.openwa_deferred_events q
    SET state='leased',lease_token=gen_random_uuid(),
        lease_until=now()+interval '3 minutes',
        attempt_count=q.attempt_count+1,updated_at=now()
    FROM picked p WHERE q.id=p.id
  RETURNING q.id,q.account_id,q.connection_id,q.session_id,
    q.own_phone_identity,q.instance_id,q.event_kind,
    q.provider_message_id,q.native_chat_id,
    q.verified_phone,q.verification_source,q.verified_at,
    q.normalized_payload,q.attempt_count,q.lease_token;
END;
$$;
CREATE FUNCTION public.claim_openwa_deferred_events_for_mode(p_canonical boolean,p_limit integer DEFAULT 5)
RETURNS TABLE (
  job_id uuid,
  account_id uuid,
  connection_id uuid,
  session_id text,
  own_phone_identity text,
  instance_id text,
  event_kind text,
  provider_message_id text,
  native_chat_id text,
  verified_phone text,
  verification_source text,
  verified_at timestamptz,
  normalized_payload jsonb,
  attempt_count integer,
  lease_token uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
BEGIN
  IF p_canonical IS NULL OR p_limit IS NULL OR p_limit<1 OR p_limit>10 THEN
    RAISE EXCEPTION 'Invalid deferred worker batch' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT q.id FROM public.openwa_deferred_events q
    WHERE (q.intake_canonical_mode IS NULL OR q.intake_canonical_mode=p_canonical) AND ((q.state='pending' AND q.next_attempt_at<=now())
       OR (q.state='leased' AND q.lease_until<now()))
    ORDER BY q.next_attempt_at,q.created_at
    FOR UPDATE OF q SKIP LOCKED LIMIT p_limit
  )
  UPDATE public.openwa_deferred_events q
    SET state='leased',lease_token=gen_random_uuid(),
        lease_until=now()+interval '3 minutes',
        attempt_count=q.attempt_count+1,updated_at=now()
    FROM picked p WHERE q.id=p.id
  RETURNING q.id,q.account_id,q.connection_id,q.session_id,
    q.own_phone_identity,q.instance_id,q.event_kind,
    q.provider_message_id,q.native_chat_id,
    q.verified_phone,q.verification_source,q.verified_at,
    q.normalized_payload,q.attempt_count,q.lease_token;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_openwa_deferred_events_for_mode(boolean,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_openwa_deferred_events_for_mode(boolean,integer) TO service_role;

CREATE FUNCTION public.openwa_intake_review_page(p_account uuid,p_actor uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=p_actor AND account_id=p_account AND account_role IN ('owner','admin')) THEN RAISE EXCEPTION 'INBOX_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'OPENWA_INTAKE_LIMIT' USING ERRCODE='22023'; END IF;
 WITH page AS MATERIALIZED(SELECT id,connection_id,intake_state,intake_reason,received_at,intake_finished_at,intake_closed_at,intake_canonical_mode FROM public.whatsapp_webhook_event_receipts
  WHERE account_id=p_account AND provider='openwa' AND intake_state IN ('review','closed_unverified') AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT p_limit+1)
 SELECT jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('id',r.id,'connection_id',r.connection_id,'display_name',left(c.display_name,160),
 'state',r.intake_state,'reason',r.intake_reason,'received_at',r.received_at,'finished_at',r.intake_finished_at,'closed_at',r.intake_closed_at,'canonical',r.intake_canonical_mode) ORDER BY r.id),'[]'::jsonb))
 INTO result FROM page r JOIN public.whatsapp_connections c ON c.account_id=p_account AND c.id=r.connection_id AND c.provider='openwa';
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.openwa_intake_review_page(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.openwa_intake_review_page(uuid,uuid,uuid,integer) TO service_role;
CREATE FUNCTION public.openwa_intake_close_unverified(p_account uuid,p_actor uuid,p_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE r public.whatsapp_webhook_event_receipts%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=p_actor AND account_id=p_account AND account_role IN ('owner','admin')) THEN RAISE EXCEPTION 'INBOX_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.whatsapp_webhook_event_receipts WHERE account_id=p_account AND id=p_id AND provider='openwa' FOR UPDATE;
 IF NOT FOUND THEN RETURN 'conflict'; END IF;
 IF r.intake_state='closed_unverified' AND r.intake_closed_by=p_actor THEN RETURN 'closed_unverified'; END IF;
 IF r.intake_state IS DISTINCT FROM 'review' OR r.processing_started_at IS NOT NULL THEN RETURN 'conflict'; END IF;
 UPDATE public.whatsapp_webhook_event_receipts SET intake_state='closed_unverified',intake_closed_by=p_actor,intake_closed_at=clock_timestamp(),intake_reason='operator_closed_unverified'
 WHERE account_id=p_account AND id=p_id AND intake_state='review';
 RETURN 'closed_unverified';
END $$;
REVOKE ALL ON FUNCTION public.openwa_intake_close_unverified(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.openwa_intake_close_unverified(uuid,uuid,uuid) TO service_role;
