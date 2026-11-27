-- FIX-05 exact release extension: upstream OpenWA v0.32.1 at
-- 0bf6740b7c51f29a2389739e9cc7a8da0cfd0b2b preserves the reviewed wwebjs
-- serialized message id and chat contract. No shared or cross-version proof,
-- no Baileys admission, no existing proof or message mutation.
ALTER TABLE public.inbox_native_namespace_proofs DROP CONSTRAINT inbox_native_proof_contract_check;
ALTER TABLE public.inbox_native_namespace_proofs ADD CONSTRAINT inbox_native_proof_contract_check CHECK (
 (scope_kind IS NULL AND engine IS NULL AND gateway_version IS NULL AND verified_by IS NULL)
 OR (scope_kind IS NOT NULL AND scope_kind='single_connection' AND engine IS NOT NULL AND engine='whatsapp-web.js'
   AND gateway_version IS NOT NULL AND gateway_version IN ('0.29.1','0.32.1')
   AND verified_by IS NOT NULL AND namespace_key='openwa:connection:'||connection_id::text)
);
CREATE OR REPLACE FUNCTION public.inbox_enroll_verified_openwa_namespace(
 p_account uuid,p_actor uuid,p_connection uuid,p_identity text,p_session text,p_instance text,
 p_connection_version timestamptz,p_credential_version timestamptz,p_checked_at timestamptz,
 p_evidence_ref uuid,p_engine text,p_gateway_version text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE c public.whatsapp_connections%ROWTYPE; cv timestamptz; v jsonb; ch uuid; ep uuid;
 proof public.inbox_native_namespace_proofs%ROWTYPE; ns text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=p_actor AND account_id=p_account AND account_role IN ('owner','admin'))
 THEN RAISE EXCEPTION 'INBOX_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_engine IS DISTINCT FROM 'whatsapp-web.js' OR (p_gateway_version IS NULL OR p_gateway_version NOT IN ('0.29.1','0.32.1')) OR p_evidence_ref IS NULL
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
CREATE OR REPLACE FUNCTION public.inbox_admin_channel_readiness(p_account uuid,p_actor uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=p_actor AND account_id=p_account AND account_role IN ('owner','admin'))
 THEN RAISE EXCEPTION 'INBOX_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>30 THEN RAISE EXCEPTION 'INBOX_BAD_LIMIT' USING ERRCODE='22023'; END IF;
 WITH page AS MATERIALIZED (
  SELECT c.* FROM public.whatsapp_connections c
  WHERE c.account_id=p_account AND c.archived_at IS NULL
    AND (p_after IS NULL OR c.id>p_after)
  ORDER BY c.id LIMIT (p_limit+1)
 ), rows AS (
  SELECT c.id, jsonb_build_object(
   'id',c.id,'provider',c.provider,'display_name',left(c.display_name,160),
   'online',CASE WHEN c.provider='openwa' THEN c.status IN ('ready','connected') ELSE c.status='connected' END,
   'identity_verified',coalesce(ep.id IS NOT NULL AND (
      (c.provider='openwa' AND c.session_id IS NOT DISTINCT FROM ep.session_snapshot
        AND c.instance_id IS NOT DISTINCT FROM ep.instance_snapshot
        AND regexp_replace(coalesce(c.phone_identity,''),'^[+]','')=split_part(ch.identity_key,':',2))
      OR (c.provider='meta_cloud' AND c.provider_external_id=ep.external_snapshot)),false),
   'identity_candidate',CASE WHEN c.provider='openwa' THEN c.session_id IS NOT NULL
       AND regexp_replace(coalesce(c.phone_identity,''),'^[+]','') ~ '^[1-9][0-9]{6,14}$'
       ELSE c.provider_external_id IS NOT NULL END,
   'channel_id',ep.channel_id,'membership_id',ep.id,'identity_verified_at',ep.verified_at,
   'last_closed_at',h.valid_until,'primary',coalesce(ep.is_primary,false),
   'credentials_present',CASE WHEN c.provider='openwa' THEN coalesce(cr.has_credentials,false) ELSE NULL END,
   'signed_webhook_configured',CASE WHEN c.provider='openwa' THEN coalesce(cr.has_signed_webhook,false) ELSE NULL END,
   'engine',CASE WHEN c.engine IN ('whatsapp-web.js','baileys') THEN c.engine END,
   'gateway_version',CASE WHEN np.scope_kind='single_connection' AND np.gateway_version IN ('0.29.1','0.32.1') THEN np.gateway_version END,
   'namespace_kind',CASE WHEN np.membership_id IS NULL THEN 'none' WHEN np.scope_kind='single_connection' THEN 'single_connection' ELSE 'shared_unclassified' END,
   'namespace_verified_at',np.verified_at,
   'namespace_contract_verified',coalesce(np.scope_kind='single_connection' AND np.engine=c.engine AND np.gateway_version IN ('0.29.1','0.32.1'),false),
   'handover_blocked',CASE WHEN c.provider='openwa' THEN
     EXISTS(SELECT 1 FROM public.whatsapp_channel_memberships m WHERE m.account_id=p_account AND m.provider='openwa'
       AND m.channel_id=coalesce(ep.channel_id,candidate.id) AND m.valid_until IS NULL AND m.is_primary AND m.connection_id<>c.id)
     OR EXISTS(SELECT 1 FROM public.inbox_native_namespace_proofs n JOIN public.whatsapp_channel_memberships m
       ON m.id=n.membership_id AND m.account_id=n.account_id AND m.provider=n.provider AND m.channel_id=n.channel_id AND m.connection_id=n.connection_id
       WHERE n.account_id=p_account AND n.provider='openwa' AND n.channel_id=coalesce(ep.channel_id,candidate.id)
         AND (n.scope_kind IS DISTINCT FROM 'single_connection' OR n.connection_id<>c.id OR n.engine IS DISTINCT FROM 'whatsapp-web.js'
           OR (n.gateway_version IS NULL OR n.gateway_version NOT IN ('0.29.1','0.32.1')) OR m.session_snapshot IS DISTINCT FROM c.session_id OR m.instance_snapshot IS DISTINCT FROM c.instance_id))
     ELSE false END,
   'held_count_capped',CASE WHEN c.provider='openwa' THEN (SELECT count(*) FROM (
      SELECT 1 FROM public.inbox_canonical_intake_review q WHERE q.account_id=p_account AND q.connection_id=c.id AND q.provider='openwa' AND q.resolved_at IS NULL LIMIT 101
   ) bounded) ELSE 0 END
  ) AS payload
  FROM page c
  LEFT JOIN public.whatsapp_channel_memberships ep ON ep.account_id=p_account AND ep.provider=c.provider AND ep.connection_id=c.id AND ep.valid_until IS NULL
  LEFT JOIN public.whatsapp_channels ch ON ch.account_id=p_account AND ch.provider=ep.provider AND ch.id=ep.channel_id
  -- Stored phone is only a collision/handover warning; never an enrollment or verified channel identifier.
  LEFT JOIN public.whatsapp_channels candidate ON candidate.account_id=p_account AND candidate.provider='openwa' AND c.provider='openwa'
    AND candidate.identity_key='e164:'||regexp_replace(coalesce(c.phone_identity,''),'^[+]','')
  LEFT JOIN public.inbox_native_namespace_proofs np ON np.account_id=p_account AND np.provider=ep.provider AND np.channel_id=ep.channel_id AND np.connection_id=ep.connection_id AND np.membership_id=ep.id
  LEFT JOIN LATERAL (
    SELECT (nullif(btrim(k.base_url),'') IS NOT NULL AND nullif(btrim(k.api_key_encrypted),'') IS NOT NULL) has_credentials,
      (nullif(btrim(k.webhook_url),'') IS NOT NULL AND nullif(btrim(k.webhook_secret_encrypted),'') IS NOT NULL) has_signed_webhook
    FROM public.whatsapp_connection_credentials k WHERE k.account_id=p_account AND k.provider='openwa' AND k.connection_id=c.id AND c.provider='openwa'
  ) cr ON true
  LEFT JOIN LATERAL (SELECT m.valid_until FROM public.whatsapp_channel_memberships m
    WHERE m.account_id=p_account AND m.provider=c.provider AND m.connection_id=c.id AND m.valid_until IS NOT NULL
    ORDER BY m.valid_until DESC LIMIT 1) h ON true
 )
 SELECT jsonb_build_object('rows',coalesce(jsonb_agg(payload ORDER BY id),'[]'::jsonb)) INTO result FROM rows;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.inbox_review_decision(p_account uuid,p_receipt uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE q public.inbox_canonical_intake_review%ROWTYPE;r public.whatsapp_webhook_event_receipts%ROWTYPE;
 o public.inbox_message_connection_observations%ROWTYPE; cm public.inbox_canonical_messages%ROWTYPE;
 e public.inbox_canonical_effects%ROWTYPE; ep public.whatsapp_channel_memberships%ROWTYPE;
 np public.inbox_native_namespace_proofs%ROWTYPE; payload jsonb; peer_phone text; at_time timestamptz;
BEGIN
 SELECT * INTO q FROM public.inbox_canonical_intake_review WHERE account_id=p_account AND receipt_id=p_receipt AND provider='openwa';
 IF NOT FOUND OR q.resolved_at IS NOT NULL THEN RETURN 'closed'; END IF;
 SELECT * INTO STRICT r FROM public.whatsapp_webhook_event_receipts WHERE id=q.receipt_id AND account_id=q.account_id AND connection_id=q.connection_id AND provider=q.provider;
 -- Finalization intentionally retains the processing token. Lease is cleared
 -- by processing_started_at, NOT token=NULL.
 IF r.intake_state IN ('pending','running') OR r.processed_at IS NULL OR r.processing_started_at IS NOT NULL OR r.processing_error IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.openwa_deferred_events d WHERE d.account_id=q.account_id AND d.connection_id=q.connection_id AND d.provider_event_id=r.provider_event_id)
 THEN RETURN 'busy'; END IF;
 SELECT * INTO o FROM public.inbox_message_connection_observations WHERE receipt_id=q.receipt_id AND account_id=q.account_id AND connection_id=q.connection_id AND provider=q.provider;
 IF NOT FOUND THEN RETURN 'unverified'; END IF;
 SELECT * INTO STRICT cm FROM public.inbox_canonical_messages WHERE id=o.canonical_id AND account_id=o.account_id AND provider=o.provider AND channel_id=o.channel_id;
 SELECT * INTO STRICT e FROM public.inbox_canonical_effects WHERE canonical_id=cm.id AND account_id=cm.account_id AND provider=cm.provider AND channel_id=cm.channel_id;
 IF e.state IN ('pending','claimed') THEN RETURN 'busy'; END IF;
 payload=q.normalized_payload;
 IF payload->>'identityKind' IS DISTINCT FROM 'native' OR payload->>'nativeId' IS DISTINCT FROM o.native_message_id
 OR o.native_message_id IS DISTINCT FROM cm.native_message_id OR o.direction IS DISTINCT FROM cm.direction
 THEN RETURN 'unverified'; END IF;
 SELECT * INTO STRICT ep FROM public.whatsapp_channel_memberships WHERE id=o.membership_id AND account_id=o.account_id AND provider=o.provider AND channel_id=o.channel_id AND connection_id=o.connection_id;
 SELECT * INTO np FROM public.inbox_native_namespace_proofs WHERE membership_id=ep.id AND account_id=ep.account_id AND provider=ep.provider AND channel_id=ep.channel_id AND connection_id=ep.connection_id;
 IF NOT FOUND OR np.namespace_key IS DISTINCT FROM cm.namespace_key OR np.verified_at>r.received_at
 OR r.received_at<ep.valid_from OR (ep.valid_until IS NOT NULL AND r.received_at>=ep.valid_until)
 THEN RETURN 'unverified'; END IF;
 -- Exact observed canonical source, not a match by text/time/native ID alone.
 IF q.reason='source_unconfirmed'
 AND (e.payload_digest IS NULL OR e.payload_digest=encode(sha256(convert_to(payload::text,'UTF8')),'hex'))
 AND cm.source_message_id IS NOT NULL AND cm.first_source_message_id=cm.source_message_id
 AND EXISTS(SELECT 1 FROM public.inbox_message_memberships im JOIN public.messages m ON m.id=im.message_id AND m.conversation_id=im.conversation_id AND m.connection_id=im.connection_id AND m.provider=im.provider
 WHERE im.account_id=cm.account_id AND im.channel_id=cm.channel_id AND im.conversation_id=cm.conversation_id AND im.message_id=cm.source_message_id
 AND im.connection_id=cm.origin_connection_id AND im.membership_id=cm.origin_membership_id AND im.provider=cm.provider
 AND m.provider_message_id=cm.native_message_id
 AND ((cm.direction='inbound' AND m.sender_type='customer') OR (cm.direction='outbound' AND m.sender_type IN ('agent','bot'))))
 THEN RETURN 'duplicate'; END IF;
 -- Narrow first recovery slice: missing plain inbound text, exact originating
 -- signed observation and contemporaneous independently verified contract.
 -- No reconstruction of media/reply/reaction, LID alias, deleted source or
 -- legacy collision. No generation of a new namespace or observation.
 IF q.reason<>'source_unconfirmed' OR cm.direction<>'inbound' OR cm.first_source_message_id IS NOT NULL OR cm.source_message_id IS NOT NULL
 OR e.state<>'awaiting_source' OR e.claim_token IS NOT NULL
 OR cm.origin_connection_id<>o.connection_id OR cm.origin_membership_id<>o.membership_id
 OR np.scope_kind IS DISTINCT FROM 'single_connection' OR np.engine IS DISTINCT FROM 'whatsapp-web.js' OR (np.gateway_version IS NULL OR np.gateway_version NOT IN ('0.29.1','0.32.1'))
 OR EXISTS(SELECT 1 FROM public.inbox_canonical_effect_stages s WHERE s.account_id=cm.account_id AND s.canonical_id=cm.id)
 OR payload->>'type' IS DISTINCT FROM 'text' OR jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR nullif(btrim(payload->>'text'),'') IS NULL
 OR (payload->'replyNativeId' IS NOT NULL AND payload->'replyNativeId'<>'null'::jsonb)
 OR (payload->'reaction' IS NOT NULL AND payload->'reaction'<>'null'::jsonb)
 OR (payload->'media' IS NOT NULL AND payload->'media'<>'null'::jsonb)
 OR coalesce(payload->>'timestamp','') !~ '^[0-9]{10}$'
 THEN RETURN 'unverified'; END IF;
 peer_phone=regexp_replace(coalesce(payload->>'from',''),'^[+]','');
 IF peer_phone !~ '^[1-9][0-9]{6,14}$' OR payload->>'chatId' IS DISTINCT FROM peer_phone||'@c.us'
 OR cm.native_message_id !~ '^false_[0-9]{5,20}@c[.]us_[A-Za-z0-9]+$'
 OR split_part(cm.native_message_id,'_',2) IS DISTINCT FROM payload->>'chatId'
 THEN RETURN 'unverified'; END IF;
 at_time=to_timestamp((payload->>'timestamp')::bigint);
 IF at_time<ep.valid_from OR at_time>r.received_at+interval '5 minutes'
 OR NOT EXISTS(SELECT 1 FROM public.conversations cv JOIN public.contacts ct ON ct.id=cv.contact_id AND ct.account_id=cv.account_id
 WHERE cv.account_id=p_account AND cv.id=cm.conversation_id AND regexp_replace(ct.phone,'^[+]','')=peer_phone)
 OR EXISTS(SELECT 1 FROM public.messages m JOIN public.conversations cv ON cv.id=m.conversation_id AND cv.account_id=p_account
 WHERE (m.connection_id=cm.origin_connection_id AND m.provider='openwa' AND m.provider_message_id=cm.native_message_id)
 OR (m.conversation_id=cm.conversation_id AND m.message_id=cm.native_message_id))
 THEN RETURN 'unverified'; END IF;
 RETURN 'restore';
END $$;
