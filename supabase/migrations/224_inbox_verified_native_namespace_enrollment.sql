-- INBOX FIX-01: explicit provider-observed, single-connection native proof.
-- No data seed, shared-engine claims, provider sends, historical backfill or new browser grants.
ALTER TABLE public.inbox_native_namespace_proofs
 ADD COLUMN scope_kind text,
 ADD COLUMN engine text,
 ADD COLUMN gateway_version text,
 ADD COLUMN verified_by uuid;
ALTER TABLE public.inbox_native_namespace_proofs ADD CONSTRAINT inbox_native_proof_contract_check CHECK (
 (scope_kind IS NULL AND engine IS NULL AND gateway_version IS NULL AND verified_by IS NULL)
 OR (scope_kind IS NOT NULL AND scope_kind='single_connection'
   AND engine IS NOT NULL AND engine='whatsapp-web.js'
   AND gateway_version IS NOT NULL AND gateway_version='0.29.1'
   AND verified_by IS NOT NULL AND namespace_key='openwa:connection:'||connection_id::text)
);
-- Minimum column grant for the server-only enrollment RPC on clean replay.
GRANT UPDATE(engine) ON public.whatsapp_connections TO service_role;

CREATE OR REPLACE FUNCTION wacrm_internal.inbox_invalidate_route()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='whatsapp_connections' THEN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.instance_id IS DISTINCT FROM OLD.instance_id
    OR NEW.engine IS DISTINCT FROM OLD.engine
    OR NEW.phone_identity IS DISTINCT FROM OLD.phone_identity OR NEW.provider_external_id IS DISTINCT FROM OLD.provider_external_id
    OR NEW.archived_at IS DISTINCT FROM OLD.archived_at OR (OLD.status IN ('connected','ready') AND NEW.status NOT IN ('connected','ready')) THEN
   UPDATE public.whatsapp_channel_memberships SET valid_until=greatest(clock_timestamp(),valid_from),is_primary=false
     WHERE account_id=OLD.account_id AND connection_id=OLD.id AND valid_until IS NULL;
  END IF;
 ELSIF TG_TABLE_NAME='whatsapp_connection_credentials' THEN
  IF TG_OP='DELETE' THEN
   UPDATE public.whatsapp_channel_memberships SET valid_until=greatest(clock_timestamp(),valid_from),is_primary=false
     WHERE account_id=OLD.account_id AND connection_id=OLD.connection_id AND valid_until IS NULL;
   RETURN OLD;
  END IF;
  IF NEW.base_url IS DISTINCT FROM OLD.base_url OR NEW.api_key_encrypted IS DISTINCT FROM OLD.api_key_encrypted
     OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.webhook_secret_encrypted IS DISTINCT FROM OLD.webhook_secret_encrypted THEN
   UPDATE public.whatsapp_channel_memberships SET valid_until=greatest(clock_timestamp(),valid_from),is_primary=false
     WHERE account_id=OLD.account_id AND connection_id=OLD.connection_id AND valid_until IS NULL;
  END IF;
 ELSIF TG_TABLE_NAME='whatsapp_config' THEN
  IF TG_OP='DELETE' THEN
   UPDATE public.whatsapp_channel_memberships SET valid_until=greatest(clock_timestamp(),valid_from),is_primary=false
     WHERE account_id=OLD.account_id AND provider='meta_cloud' AND valid_until IS NULL; RETURN OLD;
  END IF;
  IF NEW.phone_number_id IS DISTINCT FROM OLD.phone_number_id OR NEW.access_token IS DISTINCT FROM OLD.access_token
    OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.status IS DISTINCT FROM OLD.status THEN
   UPDATE public.whatsapp_channel_memberships SET valid_until=greatest(clock_timestamp(),valid_from),is_primary=false
    WHERE account_id=OLD.account_id AND provider='meta_cloud' AND valid_until IS NULL;
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.inbox_enroll_verified_openwa_namespace(
 p_account uuid,p_actor uuid,p_connection uuid,p_identity text,p_session text,p_instance text,
 p_connection_version timestamptz,p_credential_version timestamptz,p_checked_at timestamptz,
 p_evidence_ref uuid,p_engine text,p_gateway_version text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE c public.whatsapp_connections%ROWTYPE; cv timestamptz; v jsonb; ch uuid; ep uuid;
 proof public.inbox_native_namespace_proofs%ROWTYPE; ns text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=p_actor AND account_id=p_account AND account_role IN ('owner','admin'))
 THEN RAISE EXCEPTION 'INBOX_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_engine IS DISTINCT FROM 'whatsapp-web.js' OR p_gateway_version IS DISTINCT FROM '0.29.1' OR p_evidence_ref IS NULL
 THEN RAISE EXCEPTION 'INBOX_NAMESPACE_CONTRACT_UNSUPPORTED' USING ERRCODE='23514'; END IF;
 IF p_checked_at IS NULL OR p_checked_at>clock_timestamp()+interval '10 seconds' OR p_checked_at<clock_timestamp()-interval '2 minutes'
 THEN RAISE EXCEPTION 'INBOX_STALE_EVIDENCE' USING ERRCODE='23514'; END IF;
 SELECT * INTO c FROM public.whatsapp_connections WHERE account_id=p_account AND id=p_connection AND provider='openwa' FOR UPDATE;
 IF NOT FOUND OR c.archived_at IS NOT NULL OR c.status NOT IN ('ready','connected')
  OR c.updated_at IS DISTINCT FROM p_connection_version OR p_session IS NULL OR c.session_id IS DISTINCT FROM p_session
  OR c.instance_id IS DISTINCT FROM p_instance OR p_identity IS NULL OR p_identity !~ '^[1-9][0-9]{6,14}$'
  OR regexp_replace(coalesce(c.phone_identity,''),'^[+]','') IS DISTINCT FROM p_identity
 THEN RAISE EXCEPTION 'INBOX_STALE_OR_UNAVAILABLE_ROUTE' USING ERRCODE='23514'; END IF;
 SELECT updated_at INTO cv FROM public.whatsapp_connection_credentials WHERE account_id=p_account AND connection_id=p_connection
  AND provider='openwa' AND webhook_secret_encrypted IS NOT NULL AND webhook_url IS NOT NULL FOR UPDATE;
 IF NOT FOUND OR cv IS DISTINCT FROM p_credential_version THEN RAISE EXCEPTION 'INBOX_STALE_OR_UNSIGNED_ROUTE' USING ERRCODE='23514'; END IF;
 -- Updating an engine invalidates the old epoch before the fresh proof;
 -- failure below rolls the transaction back, including any role change.
 IF c.engine IS DISTINCT FROM p_engine THEN
  UPDATE public.whatsapp_connections SET engine=p_engine WHERE account_id=p_account AND id=p_connection AND provider='openwa' RETURNING * INTO c;
 END IF;
 v=public.inbox_enroll_verified_channel(p_account,p_actor,p_connection,'openwa',p_identity,p_session,p_instance,c.updated_at,cv,p_checked_at,p_evidence_ref::text,false);
 ch=(v->>'channel_id')::uuid; ep=(v->>'membership_id')::uuid;
 -- Enrollment already serializes the channel with a row lock. No implicit
 -- handover or automatic promotion of a second session with the same number.
 IF EXISTS(SELECT 1 FROM public.whatsapp_channel_memberships m WHERE m.account_id=p_account AND m.channel_id=ch AND m.valid_until IS NULL AND m.is_primary AND m.id<>ep)
 OR EXISTS(SELECT 1 FROM public.inbox_native_namespace_proofs np JOIN public.whatsapp_channel_memberships m
      ON m.id=np.membership_id AND m.account_id=np.account_id AND m.channel_id=np.channel_id AND m.connection_id=np.connection_id AND m.provider=np.provider
    WHERE np.account_id=p_account AND np.channel_id=ch
    AND (np.scope_kind IS DISTINCT FROM 'single_connection' OR np.connection_id<>p_connection
      OR np.engine IS DISTINCT FROM p_engine OR np.gateway_version IS DISTINCT FROM p_gateway_version
      OR m.session_snapshot IS DISTINCT FROM p_session OR m.instance_snapshot IS DISTINCT FROM p_instance))
 THEN RAISE EXCEPTION 'INBOX_NAMESPACE_HANDOVER_REQUIRES_PROOF' USING ERRCODE='23514'; END IF;
 ns='openwa:connection:'||p_connection::text;
 INSERT INTO public.inbox_native_namespace_proofs(account_id,provider,channel_id,connection_id,membership_id,namespace_key,evidence_ref,scope_kind,engine,gateway_version,verified_by)
 VALUES(p_account,'openwa',ch,p_connection,ep,ns,p_evidence_ref::text,'single_connection',p_engine,p_gateway_version,p_actor)
 ON CONFLICT(membership_id) DO NOTHING;
 SELECT * INTO STRICT proof FROM public.inbox_native_namespace_proofs WHERE account_id=p_account AND provider='openwa' AND channel_id=ch AND connection_id=p_connection AND membership_id=ep;
 IF proof.scope_kind IS DISTINCT FROM 'single_connection' OR proof.engine IS DISTINCT FROM p_engine
  OR proof.gateway_version IS DISTINCT FROM p_gateway_version OR proof.namespace_key IS DISTINCT FROM ns
 THEN RAISE EXCEPTION 'INBOX_NAMESPACE_PROOF_CONFLICT' USING ERRCODE='23514'; END IF;
 v=public.inbox_enroll_verified_channel(p_account,p_actor,p_connection,'openwa',p_identity,p_session,p_instance,c.updated_at,cv,p_checked_at,p_evidence_ref::text,true);
 RETURN v||jsonb_build_object('namespace_verified',true,'namespace_scope','single_connection','engine',p_engine,'gateway_version',p_gateway_version);
END $$;
REVOKE ALL ON FUNCTION public.inbox_enroll_verified_openwa_namespace(uuid,uuid,uuid,text,text,text,timestamptz,timestamptz,timestamptz,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_enroll_verified_openwa_namespace(uuid,uuid,uuid,text,text,text,timestamptz,timestamptz,timestamptz,uuid,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.inbox_record_canonical_observation(
 p_account uuid,p_connection uuid,p_event text,p_token uuid,p_conversation uuid,
 p_session text,p_instance text,p_native_id text,p_native_proven boolean,p_direction text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE r public.whatsapp_webhook_event_receipts%ROWTYPE;c public.whatsapp_connections%ROWTYPE;
 ep public.whatsapp_channel_memberships%ROWTYPE; proof public.inbox_native_namespace_proofs%ROWTYPE;
 canon public.inbox_canonical_messages%ROWTYPE; prior public.inbox_message_connection_observations%ROWTYPE;
 reason text; new_id uuid; stored_review record; authoritative public.whatsapp_channel_memberships%ROWTYPE;
BEGIN
 IF p_direction NOT IN ('inbound','outbound') OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>65536
 THEN RAISE EXCEPTION 'INBOX_BAD_OBSERVATION' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM public.whatsapp_webhook_event_receipts WHERE account_id=p_account AND connection_id=p_connection AND provider='openwa'
 AND id=public.inbox_authorized_receipt(p_account,p_connection,p_event,p_token,p_native_id) FOR UPDATE;
 IF NOT FOUND OR p_token IS NULL THEN RAISE EXCEPTION 'INBOX_SIGNED_RECEIPT_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT c FROM public.whatsapp_connections WHERE id=p_connection AND account_id=p_account AND provider='openwa' FOR SHARE;
 IF c.session_id IS DISTINCT FROM p_session OR c.instance_id IS DISTINCT FROM p_instance THEN RAISE EXCEPTION 'INBOX_ROUTE_CHANGED' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.conversations WHERE id=p_conversation AND account_id=p_account)
 THEN RAISE EXCEPTION 'INBOX_CONVERSATION_SCOPE' USING ERRCODE='23514'; END IF;
 SELECT * INTO stored_review FROM public.inbox_canonical_intake_review WHERE receipt_id=r.id AND account_id=p_account;
 IF FOUND THEN RETURN jsonb_build_object('state','review','reason',stored_review.reason); END IF;
 SELECT * INTO prior FROM public.inbox_message_connection_observations WHERE receipt_id=r.id AND account_id=p_account;
 IF FOUND THEN
  SELECT * INTO STRICT canon FROM public.inbox_canonical_messages WHERE id=prior.canonical_id AND account_id=p_account;
  IF prior.native_message_id IS DISTINCT FROM p_native_id OR prior.direction IS DISTINCT FROM p_direction OR canon.conversation_id IS DISTINCT FROM p_conversation THEN
   RAISE EXCEPTION 'INBOX_RECEIPT_PAYLOAD_CONFLICT' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('state','duplicate','canonicalId',prior.canonical_id);
 END IF;
 SELECT * INTO ep FROM public.whatsapp_channel_memberships WHERE account_id=p_account AND provider='openwa' AND connection_id=p_connection AND valid_until IS NULL FOR SHARE;
 IF NOT FOUND OR c.archived_at IS NOT NULL OR c.status NOT IN ('connected','ready') OR ep.session_snapshot IS DISTINCT FROM p_session OR ep.instance_snapshot IS DISTINCT FROM p_instance OR r.received_at<ep.valid_from
 THEN reason='missing_verified_epoch';
 ELSIF p_native_proven IS DISTINCT FROM true OR p_native_id IS NULL OR length(btrim(p_native_id)) NOT BETWEEN 1 AND 512
 THEN reason='event_only_identity';
 ELSE
  SELECT * INTO proof FROM public.inbox_native_namespace_proofs WHERE membership_id=ep.id AND account_id=p_account AND connection_id=p_connection AND channel_id=ep.channel_id AND provider='openwa';
  IF NOT FOUND THEN reason='namespace_unverified';
  ELSIF proof.scope_kind='single_connection' THEN
   IF proof.verified_at>r.received_at OR c.engine IS DISTINCT FROM proof.engine OR NOT ep.is_primary
   THEN reason='namespace_unverified';
   ELSIF p_native_id !~ '^(true|false)_[0-9]{5,20}@(c[.]us|lid)_[A-Za-z0-9]+
 END IF;
 IF reason IS NULL THEN
  -- Only the explicitly designated, currently verified primary can become
  -- the origin of a NEW inbound reservation. Secondary-first arrival
  -- records evidence without moving the frozen origin or running business effects.
  SELECT * INTO canon FROM public.inbox_canonical_messages WHERE account_id=p_account AND provider='openwa' AND channel_id=ep.channel_id
    AND namespace_key=proof.namespace_key AND direction=p_direction AND native_message_id=p_native_id FOR UPDATE;
  IF NOT FOUND THEN
   IF p_direction='outbound' THEN authoritative=ep;
   ELSE
    SELECT m.* INTO authoritative FROM public.whatsapp_channel_memberships m
     JOIN public.whatsapp_connections wc ON wc.id=m.connection_id AND wc.account_id=m.account_id AND wc.provider=m.provider
     JOIN public.inbox_native_namespace_proofs np ON np.membership_id=m.id AND np.account_id=m.account_id AND np.channel_id=m.channel_id
     WHERE m.account_id=p_account AND m.provider='openwa' AND m.channel_id=ep.channel_id AND m.is_primary AND m.valid_until IS NULL
       AND m.valid_from<=r.received_at AND np.namespace_key=proof.namespace_key AND wc.archived_at IS NULL AND wc.status IN ('ready','connected')
       AND wc.session_id IS NOT DISTINCT FROM m.session_snapshot AND wc.instance_id IS NOT DISTINCT FROM m.instance_snapshot FOR SHARE OF m,wc;
    IF NOT FOUND THEN reason='primary_unavailable'; END IF;
   END IF;
  ELSE
   SELECT * INTO STRICT authoritative FROM public.whatsapp_channel_memberships WHERE id=canon.origin_membership_id AND account_id=p_account;
  END IF;
 END IF;
 IF reason IS NULL THEN
  -- Unique canonical key serializes concurrent observations; peer mismatch
  -- is not accepted as duplicate. Direction is part of identity.
  INSERT INTO public.inbox_canonical_messages(account_id,provider,channel_id,conversation_id,namespace_key,direction,native_message_id,origin_connection_id,origin_membership_id)
  VALUES(p_account,'openwa',ep.channel_id,p_conversation,proof.namespace_key,p_direction,p_native_id,authoritative.connection_id,authoritative.id)
  ON CONFLICT(account_id,provider,channel_id,namespace_key,direction,native_message_id) DO NOTHING RETURNING id INTO new_id;
  SELECT * INTO STRICT canon FROM public.inbox_canonical_messages WHERE account_id=p_account AND provider='openwa' AND channel_id=ep.channel_id
    AND namespace_key=proof.namespace_key AND direction=p_direction AND native_message_id=p_native_id FOR UPDATE;
  IF canon.conversation_id<>p_conversation THEN reason='peer_conflict';
  ELSE
   INSERT INTO public.inbox_message_connection_observations(account_id,provider,channel_id,connection_id,membership_id,canonical_id,receipt_id,native_message_id,direction)
   VALUES(p_account,'openwa',ep.channel_id,p_connection,ep.id,canon.id,r.id,p_native_id,p_direction)
   ON CONFLICT(receipt_id) DO NOTHING;
   INSERT INTO public.inbox_canonical_effects(canonical_id,account_id,provider,channel_id)
   VALUES(canon.id,p_account,'openwa',ep.channel_id) ON CONFLICT(canonical_id) DO NOTHING;
   RETURN jsonb_build_object('state',CASE WHEN new_id IS NULL THEN 'duplicate' ELSE 'reserved' END,'canonicalId',canon.id);
  END IF;
 END IF;
 INSERT INTO public.inbox_canonical_intake_review(receipt_id,account_id,connection_id,provider,reason,normalized_payload)
 VALUES(r.id,p_account,p_connection,'openwa',reason,p_payload);
 RETURN jsonb_build_object('state','review','reason',reason);
END $$;
    OR split_part(p_native_id,'_',2) IS DISTINCT FROM (p_payload->>'chatId')
    OR split_part(p_native_id,'_',1) IS DISTINCT FROM (CASE WHEN p_direction='inbound' THEN 'false' ELSE 'true' END)
   THEN reason='peer_conflict'; END IF;
  END IF;
 END IF;
 IF reason IS NULL THEN
  -- Only the explicitly designated, currently verified primary can become
  -- the origin of a NEW inbound reservation. Secondary-first arrival
  -- records evidence without moving the frozen origin or running business effects.
  SELECT * INTO canon FROM public.inbox_canonical_messages WHERE account_id=p_account AND provider='openwa' AND channel_id=ep.channel_id
    AND namespace_key=proof.namespace_key AND direction=p_direction AND native_message_id=p_native_id FOR UPDATE;
  IF NOT FOUND THEN
   IF p_direction='outbound' THEN authoritative=ep;
   ELSE
    SELECT m.* INTO authoritative FROM public.whatsapp_channel_memberships m
     JOIN public.whatsapp_connections wc ON wc.id=m.connection_id AND wc.account_id=m.account_id AND wc.provider=m.provider
     JOIN public.inbox_native_namespace_proofs np ON np.membership_id=m.id AND np.account_id=m.account_id AND np.channel_id=m.channel_id
     WHERE m.account_id=p_account AND m.provider='openwa' AND m.channel_id=ep.channel_id AND m.is_primary AND m.valid_until IS NULL
       AND m.valid_from<=r.received_at AND np.namespace_key=proof.namespace_key AND wc.archived_at IS NULL AND wc.status IN ('ready','connected')
       AND wc.session_id IS NOT DISTINCT FROM m.session_snapshot AND wc.instance_id IS NOT DISTINCT FROM m.instance_snapshot FOR SHARE OF m,wc;
    IF NOT FOUND THEN reason='primary_unavailable'; END IF;
   END IF;
  ELSE
   SELECT * INTO STRICT authoritative FROM public.whatsapp_channel_memberships WHERE id=canon.origin_membership_id AND account_id=p_account;
  END IF;
 END IF;
 IF reason IS NULL THEN
  -- Unique canonical key serializes concurrent observations; peer mismatch
  -- is not accepted as duplicate. Direction is part of identity.
  INSERT INTO public.inbox_canonical_messages(account_id,provider,channel_id,conversation_id,namespace_key,direction,native_message_id,origin_connection_id,origin_membership_id)
  VALUES(p_account,'openwa',ep.channel_id,p_conversation,proof.namespace_key,p_direction,p_native_id,authoritative.connection_id,authoritative.id)
  ON CONFLICT(account_id,provider,channel_id,namespace_key,direction,native_message_id) DO NOTHING RETURNING id INTO new_id;
  SELECT * INTO STRICT canon FROM public.inbox_canonical_messages WHERE account_id=p_account AND provider='openwa' AND channel_id=ep.channel_id
    AND namespace_key=proof.namespace_key AND direction=p_direction AND native_message_id=p_native_id FOR UPDATE;
  IF canon.conversation_id<>p_conversation THEN reason='peer_conflict';
  ELSE
   INSERT INTO public.inbox_message_connection_observations(account_id,provider,channel_id,connection_id,membership_id,canonical_id,receipt_id,native_message_id,direction)
   VALUES(p_account,'openwa',ep.channel_id,p_connection,ep.id,canon.id,r.id,p_native_id,p_direction)
   ON CONFLICT(receipt_id) DO NOTHING;
   INSERT INTO public.inbox_canonical_effects(canonical_id,account_id,provider,channel_id)
   VALUES(canon.id,p_account,'openwa',ep.channel_id) ON CONFLICT(canonical_id) DO NOTHING;
   RETURN jsonb_build_object('state',CASE WHEN new_id IS NULL THEN 'duplicate' ELSE 'reserved' END,'canonicalId',canon.id);
  END IF;
 END IF;
 INSERT INTO public.inbox_canonical_intake_review(receipt_id,account_id,connection_id,provider,reason,normalized_payload)
 VALUES(r.id,p_account,p_connection,'openwa',reason,p_payload);
 RETURN jsonb_build_object('state','review','reason',reason);
END $$;

CREATE OR REPLACE FUNCTION public.inbox_active_observation_epoch(p_account uuid,p_connection uuid,p_session text,p_instance text,p_received timestamptz)
RETURNS public.whatsapp_channel_memberships LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE ep public.whatsapp_channel_memberships%ROWTYPE;
BEGIN
 SELECT m.* INTO ep FROM public.whatsapp_channel_memberships m JOIN public.whatsapp_connections wc ON wc.id=m.connection_id AND wc.account_id=m.account_id AND wc.provider=m.provider
 JOIN public.inbox_native_namespace_proofs np ON np.membership_id=m.id AND np.account_id=m.account_id AND np.channel_id=m.channel_id
 WHERE m.account_id=p_account AND m.connection_id=p_connection AND m.provider='openwa' AND m.valid_until IS NULL AND m.valid_from<=p_received
 AND m.session_snapshot=p_session AND m.instance_snapshot IS NOT DISTINCT FROM p_instance AND wc.session_id=p_session AND wc.instance_id IS NOT DISTINCT FROM p_instance
 AND wc.archived_at IS NULL AND wc.status IN ('ready','connected')
 AND (np.scope_kind IS NULL OR (np.verified_at<=p_received AND wc.engine=np.engine AND m.is_primary)) FOR SHARE OF m,wc;
 RETURN ep;
END $$;

CREATE OR REPLACE FUNCTION public.inbox_validate_canonical_route(p_account uuid,p_conversation uuid,p_message uuid,p_connection uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.inbox_message_memberships im
 JOIN public.inbox_canonical_messages cm ON cm.id::text=im.evidence_ref AND cm.account_id=im.account_id AND cm.source_message_id=im.message_id AND cm.direction='inbound'
 JOIN public.whatsapp_channel_memberships ep ON ep.id=im.membership_id AND ep.account_id=im.account_id AND ep.connection_id=im.connection_id AND ep.channel_id=im.channel_id
 JOIN public.whatsapp_connections wc ON wc.id=ep.connection_id AND wc.account_id=ep.account_id AND wc.provider=ep.provider
 JOIN public.inbox_native_namespace_proofs np ON np.membership_id=ep.id AND np.account_id=ep.account_id AND np.channel_id=ep.channel_id
 WHERE im.account_id=p_account AND im.conversation_id=p_conversation AND im.message_id=p_message AND im.connection_id=p_connection
 AND im.evidence_kind='verified_current_ingress' AND ep.valid_until IS NULL AND wc.archived_at IS NULL AND wc.status IN ('ready','connected')
 AND wc.session_id IS NOT DISTINCT FROM ep.session_snapshot AND wc.instance_id IS NOT DISTINCT FROM ep.instance_snapshot
 AND cm.origin_membership_id=ep.id AND cm.namespace_key=np.namespace_key
 AND (np.scope_kind IS NULL OR (wc.engine=np.engine AND ep.is_primary)))
$$;

COMMENT ON TABLE public.inbox_native_namespace_proofs IS 'Server-only immutable membership-bound native evidence. Single-connection reviewed contract is not shared across sessions; no seeded or retrospective proof.';
