-- FIX-02: bounded, redacted, administrator-only channel readiness and explicit
-- epoch revocation. No provider dispatch, session lifecycle, proof fabrication,
-- history repair, implicit primary promotion or policy activation.
CREATE INDEX inbox_readiness_live_registry_idx ON public.whatsapp_connections(account_id,id) WHERE archived_at IS NULL;
CREATE INDEX inbox_readiness_membership_history_idx ON public.whatsapp_channel_memberships(account_id,connection_id,valid_until DESC) WHERE valid_until IS NOT NULL;
CREATE INDEX inbox_readiness_proof_channel_idx ON public.inbox_native_namespace_proofs(account_id,channel_id);
CREATE INDEX inbox_readiness_review_route_idx ON public.inbox_canonical_intake_review(account_id,connection_id) WHERE resolved_at IS NULL;

CREATE FUNCTION public.inbox_admin_channel_readiness(p_account uuid,p_actor uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 20)
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
   'gateway_version',CASE WHEN np.scope_kind='single_connection' AND np.gateway_version='0.29.1' THEN np.gateway_version END,
   'namespace_kind',CASE WHEN np.membership_id IS NULL THEN 'none' WHEN np.scope_kind='single_connection' THEN 'single_connection' ELSE 'shared_unclassified' END,
   'namespace_verified_at',np.verified_at,
   'namespace_contract_verified',coalesce(np.scope_kind='single_connection' AND np.engine=c.engine AND np.gateway_version='0.29.1',false),
   'handover_blocked',CASE WHEN c.provider='openwa' THEN
     EXISTS(SELECT 1 FROM public.whatsapp_channel_memberships m WHERE m.account_id=p_account AND m.provider='openwa'
       AND m.channel_id=coalesce(ep.channel_id,candidate.id) AND m.valid_until IS NULL AND m.is_primary AND m.connection_id<>c.id)
     OR EXISTS(SELECT 1 FROM public.inbox_native_namespace_proofs n JOIN public.whatsapp_channel_memberships m
       ON m.id=n.membership_id AND m.account_id=n.account_id AND m.provider=n.provider AND m.channel_id=n.channel_id AND m.connection_id=n.connection_id
       WHERE n.account_id=p_account AND n.provider='openwa' AND n.channel_id=coalesce(ep.channel_id,candidate.id)
         AND (n.scope_kind IS DISTINCT FROM 'single_connection' OR n.connection_id<>c.id OR n.engine IS DISTINCT FROM 'whatsapp-web.js'
           OR n.gateway_version IS DISTINCT FROM '0.29.1' OR m.session_snapshot IS DISTINCT FROM c.session_id OR m.instance_snapshot IS DISTINCT FROM c.instance_id))
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
REVOKE ALL ON FUNCTION public.inbox_admin_channel_readiness(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_admin_channel_readiness(uuid,uuid,uuid,integer) TO service_role;

-- Explicit revocation only: preserve membership history and proof, do not
-- promote a replacement. Caller must independently authorize TEST maintenance
-- (canonical ingress/actions off, workers quiesced). Stale epoch/role fails closed.
CREATE FUNCTION public.inbox_admin_revoke_openwa_enrollment(p_account uuid,p_actor uuid,p_connection uuid,p_membership uuid,p_was_primary boolean,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE c public.whatsapp_connections%ROWTYPE; ep public.whatsapp_channel_memberships%ROWTYPE; ch uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=p_actor AND account_id=p_account AND account_role IN ('owner','admin'))
 THEN RAISE EXCEPTION 'INBOX_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_membership IS NULL OR p_was_primary IS NULL OR p_request IS NULL
 THEN RAISE EXCEPTION 'INBOX_BAD_REVOCATION' USING ERRCODE='22023'; END IF;
 SELECT * INTO c FROM public.whatsapp_connections WHERE account_id=p_account AND id=p_connection AND provider='openwa' FOR UPDATE;
 IF NOT FOUND OR c.archived_at IS NOT NULL THEN RETURN jsonb_build_object('state','conflict'); END IF;
 SELECT channel_id INTO ch FROM public.whatsapp_channel_memberships WHERE account_id=p_account AND provider='openwa' AND connection_id=p_connection AND id=p_membership;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','conflict'); END IF;
 PERFORM 1 FROM public.whatsapp_channels WHERE account_id=p_account AND provider='openwa' AND id=ch FOR NO KEY UPDATE;
 SELECT * INTO ep FROM public.whatsapp_channel_memberships WHERE account_id=p_account AND provider='openwa' AND connection_id=p_connection AND id=p_membership AND channel_id=ch FOR UPDATE;
 IF NOT FOUND OR ep.valid_until IS NOT NULL OR ep.is_primary IS DISTINCT FROM p_was_primary THEN RETURN jsonb_build_object('state','conflict'); END IF;
 IF EXISTS(SELECT 1 FROM public.inbox_canonical_messages cm JOIN public.inbox_canonical_effects e ON e.canonical_id=cm.id AND e.account_id=cm.account_id AND e.provider=cm.provider AND e.channel_id=cm.channel_id
   WHERE cm.account_id=p_account AND cm.origin_connection_id=p_connection AND cm.origin_membership_id=ep.id AND e.state IN ('pending','claimed'))
 OR EXISTS(SELECT 1 FROM public.inbox_action_intents a WHERE a.account_id=p_account AND a.connection_id=p_connection AND a.membership_id=ep.id AND a.state='pending')
 THEN RETURN jsonb_build_object('state','busy'); END IF;
 UPDATE public.whatsapp_channel_memberships SET valid_until=greatest(clock_timestamp(),valid_from),is_primary=false
 WHERE account_id=p_account AND provider='openwa' AND channel_id=ch AND connection_id=p_connection AND id=ep.id AND valid_until IS NULL;
 -- The immutable epoch trigger records system closure. The actor-specific
 -- record identifies this deliberate administrative action, not provider proof.
 INSERT INTO public.inbox_integrity_audit(account_id,actor_id,event_type,channel_id,connection_id,membership_id,evidence_ref)
 VALUES(p_account,p_actor,'membership_closed',ch,p_connection,ep.id,'operator-revocation:'||p_request::text);
 RETURN jsonb_build_object('state','revoked');
END $$;
REVOKE ALL ON FUNCTION public.inbox_admin_revoke_openwa_enrollment(uuid,uuid,uuid,uuid,boolean,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_admin_revoke_openwa_enrollment(uuid,uuid,uuid,uuid,boolean,uuid) TO service_role;
