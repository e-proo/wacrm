-- SOF-78: exact policy context, signed Meta ingress and shared OpenWA cap.
-- No browser execution, provider calls, legacy backfill or flag activation.
CREATE OR REPLACE FUNCTION public.inbox_guard_message_membership()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.evidence_kind='verified_current_ingress' AND NEW.provider='meta_cloud' THEN
  IF NOT EXISTS(SELECT 1 FROM public.inbox_verified_message_evidence e
   JOIN public.messages m ON m.id=e.message_id AND m.conversation_id=e.conversation_id
   WHERE e.message_id=NEW.message_id AND e.account_id=NEW.account_id AND e.conversation_id=NEW.conversation_id
   AND e.provider=NEW.provider AND e.channel_id=NEW.channel_id AND e.connection_id=NEW.connection_id AND e.membership_id=NEW.membership_id
   AND e.evidence_ref='meta-signed-ingress:v1:'||NEW.message_id::text AND e.evidence_ref=NEW.evidence_ref
   AND m.provider=NEW.provider AND m.connection_id=NEW.connection_id AND m.sender_type='customer' AND m.provider_message_id=e.native_message_id)
  THEN RAISE EXCEPTION 'INBOX_META_SIGNED_PROOF_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.evidence_kind='verified_current_ingress' THEN
  IF NOT EXISTS(SELECT 1 FROM public.inbox_canonical_messages c
   JOIN public.messages m ON m.id=c.source_message_id AND m.conversation_id=c.conversation_id
   JOIN public.inbox_message_connection_observations o ON o.canonical_id=c.id AND o.account_id=c.account_id AND o.connection_id=c.origin_connection_id AND o.membership_id=c.origin_membership_id
   WHERE c.id::text=NEW.evidence_ref AND c.source_message_id=NEW.message_id AND c.account_id=NEW.account_id AND c.channel_id=NEW.channel_id AND c.conversation_id=NEW.conversation_id
   AND c.provider=NEW.provider AND c.origin_connection_id=NEW.connection_id AND c.origin_membership_id=NEW.membership_id AND c.direction='inbound'
   AND m.provider=NEW.provider AND m.connection_id=NEW.connection_id AND m.sender_type='customer' AND m.provider_message_id=c.native_message_id)
  THEN RAISE EXCEPTION 'INBOX_CURRENT_INGRESS_PROOF_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.evidence_kind='verified_outbound_reservation' THEN
  IF NOT EXISTS(SELECT 1 FROM public.inbox_canonical_messages c JOIN public.messages m ON m.id=c.source_message_id AND m.conversation_id=c.conversation_id
   JOIN public.inbox_message_connection_observations o ON o.canonical_id=c.id AND o.account_id=c.account_id AND o.connection_id=c.origin_connection_id AND o.membership_id=c.origin_membership_id
   WHERE c.id::text=NEW.evidence_ref AND c.source_message_id=NEW.message_id AND c.account_id=NEW.account_id AND c.channel_id=NEW.channel_id AND c.conversation_id=NEW.conversation_id
   AND c.provider=NEW.provider AND c.origin_connection_id=NEW.connection_id AND c.origin_membership_id=NEW.membership_id AND c.direction='outbound'
   AND m.provider=NEW.provider AND m.connection_id=NEW.connection_id AND m.sender_type IN ('agent','bot') AND m.provider_message_id=c.native_message_id)
  THEN RAISE EXCEPTION 'INBOX_OUTBOUND_PROOF_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.evidence_kind<>'verified_historical_epoch' THEN RAISE EXCEPTION 'INBOX_MESSAGE_PROOF_REQUIRED' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id
 JOIN public.inbox_verified_message_evidence e ON e.message_id=m.id AND e.conversation_id=m.conversation_id AND e.native_message_id=m.provider_message_id
 WHERE m.id=NEW.message_id AND m.conversation_id=NEW.conversation_id AND c.account_id=NEW.account_id
 AND m.provider=NEW.provider AND m.connection_id=NEW.connection_id AND e.account_id=NEW.account_id AND e.channel_id=NEW.channel_id
 AND e.provider=NEW.provider AND e.connection_id=NEW.connection_id AND e.membership_id=NEW.membership_id AND e.evidence_ref=NEW.evidence_ref)
 THEN RAISE EXCEPTION 'INBOX_MESSAGE_PROOF_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.inbox_guard_message_membership() FROM PUBLIC,anon,authenticated;

-- Only the authenticated server webhook supplies a signed phone_number_id,
-- native message identity, sender and timestamp after a fresh source insert.
-- Never infer proof from the CRM parent, replay, or stored current phone alone.
CREATE FUNCTION public.inbox_record_meta_signed_ingress(p_account uuid,p_connection uuid,p_conversation uuid,p_message uuid,p_native text,p_external text,p_sender text,p_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE ep public.whatsapp_channel_memberships%ROWTYPE; t public.inbox_threads%ROWTYPE; seq bigint; v_now timestamptz:=clock_timestamp(); proof text;
BEGIN
 IF p_native IS NULL OR length(btrim(p_native)) NOT BETWEEN 1 AND 512 OR p_sender IS NULL OR p_sender !~ '^[1-9][0-9]{6,14}$'
 OR p_at IS NULL OR p_at>v_now OR p_external IS NULL THEN RETURN false; END IF;
 PERFORM 1 FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id AND c.account_id=p_account
 JOIN public.contacts ct ON ct.id=c.contact_id AND ct.account_id=p_account
 WHERE m.id=p_message AND m.conversation_id=p_conversation AND m.provider='meta_cloud' AND m.connection_id=p_connection
 AND m.sender_type='customer' AND m.provider_message_id=p_native AND m.created_at=p_at AND regexp_replace(ct.phone,'[^0-9]','','g')=p_sender
 FOR UPDATE OF m;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT e.* INTO ep FROM public.whatsapp_channel_memberships e JOIN public.whatsapp_connections w ON w.account_id=e.account_id AND w.id=e.connection_id AND w.provider=e.provider
 JOIN public.whatsapp_config cfg ON cfg.account_id=e.account_id AND cfg.phone_number_id=e.external_snapshot
 WHERE e.account_id=p_account AND e.connection_id=p_connection AND e.provider='meta_cloud' AND e.valid_until IS NULL
 AND e.external_snapshot=p_external AND w.provider_external_id=p_external AND w.archived_at IS NULL AND w.status='connected' AND cfg.status='connected'
 AND p_at>=e.valid_from FOR SHARE OF e,w,cfg;
 IF NOT FOUND THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.inbox_message_memberships WHERE message_id=p_message) THEN
  RETURN EXISTS(SELECT 1 FROM public.inbox_message_memberships WHERE message_id=p_message AND account_id=p_account AND membership_id=ep.id AND evidence_kind='verified_current_ingress');
 END IF;
 proof='meta-signed-ingress:v1:'||p_message::text;
 INSERT INTO public.inbox_verified_message_evidence(message_id,account_id,conversation_id,provider,channel_id,connection_id,membership_id,native_message_id,observed_at,evidence_ref)
 VALUES(p_message,p_account,p_conversation,'meta_cloud',ep.channel_id,p_connection,ep.id,p_native,v_now,proof)
 ON CONFLICT(message_id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_verified_message_evidence WHERE message_id=p_message AND evidence_ref=proof AND membership_id=ep.id) THEN RETURN false; END IF;
 INSERT INTO public.inbox_threads(account_id,conversation_id,channel_id,provider)
 VALUES(p_account,p_conversation,ep.channel_id,'meta_cloud') ON CONFLICT(account_id,conversation_id,channel_id) DO NOTHING;
 SELECT * INTO STRICT t FROM public.inbox_threads WHERE account_id=p_account AND conversation_id=p_conversation AND channel_id=ep.channel_id FOR UPDATE;
 seq=t.ingest_highwater+1;
 UPDATE public.inbox_threads SET ingest_highwater=seq WHERE account_id=p_account AND id=t.id;
 INSERT INTO public.inbox_message_memberships(message_id,account_id,conversation_id,channel_id,thread_id,provider,connection_id,membership_id,evidence_kind,evidence_ref,ingest_sequence)
 VALUES(p_message,p_account,p_conversation,ep.channel_id,t.id,'meta_cloud',p_connection,ep.id,'verified_current_ingress',proof,seq);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.inbox_record_meta_signed_ingress(uuid,uuid,uuid,uuid,text,text,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_record_meta_signed_ingress(uuid,uuid,uuid,uuid,text,text,text,timestamptz) TO service_role;

-- Read-only server context. Explicit connection or declared ready primary;
-- no default to latest inbound, sibling session, or legacy CRM provider.
CREATE FUNCTION public.inbox_policy_context(p_account uuid,p_actor uuid,p_thread uuid,p_channel uuid,p_connection uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE t public.inbox_threads%ROWTYPE; ep public.whatsapp_channel_memberships%ROWTYPE; actor_role text; phone text; inbound record; ready boolean:=false; verified_recipient text; last_inbound timestamptz; v_now timestamptz:=statement_timestamp();
BEGIN
 SELECT account_role::text INTO actor_role FROM public.profiles WHERE account_id=p_account AND user_id=p_actor;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_POLICY_ACTOR' USING ERRCODE='42501'; END IF;
 SELECT * INTO t FROM public.inbox_threads WHERE account_id=p_account AND channel_id=p_channel AND id=p_thread;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT e.* INTO ep FROM public.whatsapp_channel_memberships e
 WHERE e.account_id=p_account AND e.channel_id=t.channel_id AND e.provider=t.provider AND e.valid_until IS NULL
 AND ((p_connection IS NOT NULL AND e.connection_id=p_connection) OR (p_connection IS NULL AND e.is_primary));
 IF p_connection IS NOT NULL AND NOT FOUND THEN RETURN NULL; END IF;
 IF ep.id IS NOT NULL THEN
  SELECT EXISTS(SELECT 1 FROM public.inbox_read_ready_sessions(p_account) r WHERE r.channel_id=t.channel_id AND r.connection_id=ep.connection_id) INTO ready;
  SELECT regexp_replace(ct.phone,'[^0-9]','','g') INTO phone FROM public.conversations c JOIN public.contacts ct ON ct.id=c.contact_id AND ct.account_id=c.account_id WHERE c.id=t.conversation_id AND c.account_id=p_account;
  SELECT m.created_at,m.provider_chat_id INTO inbound FROM public.inbox_message_memberships im
  JOIN public.messages m ON m.id=im.message_id AND m.conversation_id=im.conversation_id AND m.provider=im.provider AND m.connection_id=im.connection_id
  WHERE im.account_id=p_account AND im.thread_id=t.id AND im.channel_id=t.channel_id AND im.provider=t.provider
   AND im.connection_id=ep.connection_id AND im.membership_id=ep.id AND im.evidence_kind='verified_current_ingress'
   AND m.sender_type='customer' AND m.created_at<=v_now AND m.created_at>=ep.valid_from
  ORDER BY m.created_at DESC,m.id DESC LIMIT 1;
  IF t.provider='meta_cloud' THEN
   last_inbound=inbound.created_at;
   ready=ready AND EXISTS(SELECT 1 FROM public.whatsapp_config cfg WHERE cfg.account_id=p_account AND cfg.phone_number_id=ep.external_snapshot AND cfg.status='connected');
   IF phone~'^[1-9][0-9]{6,14}$' THEN verified_recipient=phone; END IF;
  ELSE
   -- Exact native inbound route only; a LID never becomes a phone. If the
   -- selected epoch has no inbound, allow explicit valid CRM phone only
   -- when no ambiguous/native inbound exists anywhere in this parent.
   IF inbound.provider_chat_id~'^[0-9]{5,20}@lid$' OR (inbound.provider_chat_id~'^[1-9][0-9]{6,14}@c[.]us$' AND split_part(inbound.provider_chat_id,'@',1)=phone) THEN
    verified_recipient=inbound.provider_chat_id;
   ELSIF inbound.created_at IS NULL AND phone~'^[1-9][0-9]{6,14}$' AND NOT EXISTS(
    SELECT 1 FROM public.messages m WHERE m.conversation_id=t.conversation_id AND m.sender_type='customer' AND (m.provider IS NULL OR m.provider='openwa')
   ) THEN verified_recipient=phone; END IF;
   ready=ready AND EXISTS(SELECT 1 FROM public.whatsapp_connection_credentials c WHERE c.account_id=p_account AND c.connection_id=ep.connection_id AND c.provider='openwa');
  END IF;
 END IF;
 RETURN jsonb_build_object('thread_id',t.id,'conversation_id',t.conversation_id,'channel_id',t.channel_id,'provider',t.provider,
 'connection_id',ep.connection_id,'membership_id',ep.id,'ready',ready,'can_operate',actor_role IN ('owner','admin','agent'),
 'recipient',verified_recipient,'last_inbound_at',last_inbound,'server_now',v_now);
END $$;
REVOKE ALL ON FUNCTION public.inbox_policy_context(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_policy_context(uuid,uuid,uuid,uuid,uuid) TO service_role;

-- Read-only quota inspection; actual existing reservation remains authoritative.
-- Shared caps use the strictest current verified member's configured limits
-- (default warm-up caps when missing). All recent reservations from historical
-- member connections count conservatively; per-connection hashes stay opaque.
CREATE FUNCTION public.inbox_openwa_channel_cap_reason(p_account uuid,p_channel uuid,p_connection uuid,p_hash text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE h int; d int; f int; hu bigint; du bigint; fu bigint; known boolean; v_now timestamptz:=clock_timestamp();
BEGIN
 SELECT min(CASE WHEN g.connection_id IS NULL OR g.warmup_until>v_now THEN least(coalesce(g.hourly_cap,60),coalesce(g.warmup_hourly_cap,20)) ELSE g.hourly_cap END),
 min(CASE WHEN g.connection_id IS NULL OR g.warmup_until>v_now THEN least(coalesce(g.daily_cap,500),coalesce(g.warmup_daily_cap,100)) ELSE g.daily_cap END),
 min(coalesce(g.first_touch_daily_cap,100)) INTO h,d,f
 FROM public.whatsapp_channel_memberships e LEFT JOIN public.whatsapp_connection_guardrails g ON g.account_id=e.account_id AND g.connection_id=e.connection_id
 WHERE e.account_id=p_account AND e.channel_id=p_channel AND e.provider='openwa' AND e.valid_until IS NULL;
 IF h IS NULL OR d IS NULL OR f IS NULL THEN RETURN 'channel_policy_unavailable'; END IF;
 SELECT count(*) FILTER(WHERE ev.created_at>=v_now-interval '1 hour'),count(*),count(DISTINCT ev.recipient_hash)
 INTO hu,du,fu FROM public.whatsapp_guardrail_events ev
 WHERE ev.account_id=p_account AND ev.decision='reserved' AND ev.created_at>=v_now-interval '24 hours'
 AND EXISTS(SELECT 1 FROM public.whatsapp_channel_memberships e WHERE e.account_id=p_account AND e.channel_id=p_channel AND e.provider='openwa' AND e.connection_id=ev.connection_id);
 IF hu>=h THEN RETURN 'channel_hourly_cap'; END IF;
 IF du>=d THEN RETURN 'channel_daily_cap'; END IF;
 SELECT EXISTS(SELECT 1 FROM public.whatsapp_guardrail_events WHERE account_id=p_account AND connection_id=p_connection AND recipient_hash=p_hash AND decision IN ('reserved','success') AND created_at<v_now) INTO known;
 IF NOT known AND fu>=f THEN RETURN 'channel_first_touch_cap'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.inbox_openwa_channel_cap_reason(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_openwa_channel_cap_reason(uuid,uuid,uuid,text) TO service_role;

-- Run inside the existing reservation transaction. One channel lock across
-- all workloads and member sessions; no second reservation or counter table.
-- Unknown legacy sessions keep their original policy, not a guessed identity.
CREATE FUNCTION wacrm_internal.inbox_openwa_channel_reservation_fence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ch uuid; reason text;
BEGIN
 IF NEW.decision<>'reserved' THEN RETURN NEW; END IF;
 SELECT channel_id INTO ch FROM public.whatsapp_channel_memberships WHERE account_id=NEW.account_id AND connection_id=NEW.connection_id AND provider='openwa' AND valid_until IS NULL;
 IF ch IS NULL THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('inbox-channel-cap:'||NEW.account_id::text||':'||ch::text,0));
 reason=public.inbox_openwa_channel_cap_reason(NEW.account_id,ch,NEW.connection_id,NEW.recipient_hash);
 IF reason IS NOT NULL THEN RAISE EXCEPTION 'INBOX_CHANNEL_CAP:%',reason USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_openwa_channel_reservation_fence() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER inbox_openwa_channel_reservation_fence BEFORE INSERT ON public.whatsapp_guardrail_events FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_openwa_channel_reservation_fence();
