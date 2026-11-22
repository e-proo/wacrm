-- SOF-85: immutable action admission journal, not a second message queue.
-- No provider calls, browser access, or feature activation.
CREATE TABLE public.inbox_action_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL, actor_id uuid NOT NULL, request_key uuid NOT NULL,
 thread_id uuid NOT NULL, conversation_id uuid NOT NULL, channel_id uuid NOT NULL,
 connection_id uuid NOT NULL, membership_id uuid NOT NULL,
 provider text NOT NULL CHECK(provider IN ('meta_cloud','openwa')),
 action_kind text NOT NULL CHECK(action_kind IN ('send','provider_read','reaction')),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 recipient_hash text NOT NULL CHECK(recipient_hash ~ '^[0-9a-f]{64}$'),
 dispatch_started_at timestamptz,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','blocked','uncertain')),
 message_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
 UNIQUE(account_id,request_key),
 CHECK((state='pending')=(finished_at IS NULL))
);
ALTER TABLE public.inbox_action_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbox_action_intents FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.inbox_action_intents TO service_role;
-- Transition writes are limited to the scoped private functions below.
CREATE POLICY inbox_action_service_only ON public.inbox_action_intents FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE INDEX inbox_action_thread_idx ON public.inbox_action_intents(account_id,thread_id,created_at DESC);
-- Same key never admits a second execution, even after an uncertain result.
-- No expiry/reset that could turn a crashed request into another dispatch.
CREATE FUNCTION public.inbox_claim_action(p_account uuid,p_actor uuid,p_key uuid,p_thread uuid,p_channel uuid,p_connection uuid,p_membership uuid,p_provider text,p_kind text,p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE a public.inbox_action_intents%ROWTYPE; c jsonb; inserted boolean:=false;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE account_id=p_account AND user_id=p_actor AND account_role::text IN ('owner','admin','agent')) THEN RAISE EXCEPTION 'INBOX_ACTION_ACTOR' USING ERRCODE='42501'; END IF;
 IF p_key IS NULL OR p_thread IS NULL OR p_channel IS NULL OR p_connection IS NULL OR p_membership IS NULL OR p_provider IS NULL OR p_provider NOT IN ('meta_cloud','openwa') OR p_kind IS NULL OR p_kind NOT IN ('send','provider_read','reaction') OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INBOX_ACTION_INPUT' USING ERRCODE='22023'; END IF;
 SELECT * INTO a FROM public.inbox_action_intents WHERE account_id=p_account AND request_key=p_key;
 IF NOT FOUND THEN
  c=public.inbox_policy_context(p_account,p_actor,p_thread,p_channel,p_connection);
  IF c IS NULL OR c->>'connection_id' IS DISTINCT FROM p_connection::text OR c->>'membership_id' IS DISTINCT FROM p_membership::text OR c->>'provider' IS DISTINCT FROM p_provider OR c->>'ready' IS DISTINCT FROM 'true' OR c->>'can_operate' IS DISTINCT FROM 'true' OR c->>'recipient' IS NULL THEN RETURN jsonb_build_object('state','denied'); END IF;
  INSERT INTO public.inbox_action_intents(account_id,actor_id,request_key,thread_id,conversation_id,channel_id,connection_id,membership_id,provider,action_kind,fingerprint,recipient_hash)
  VALUES(p_account,p_actor,p_key,p_thread,(c->>'conversation_id')::uuid,p_channel,p_connection,p_membership,p_provider,p_kind,p_fingerprint,encode(sha256(convert_to(c->>'recipient','UTF8')),'hex'))
  ON CONFLICT(account_id,request_key) DO NOTHING RETURNING * INTO a;
  inserted=FOUND;
  IF NOT inserted THEN SELECT * INTO STRICT a FROM public.inbox_action_intents WHERE account_id=p_account AND request_key=p_key; END IF;
 END IF;
 IF a.actor_id IS DISTINCT FROM p_actor OR a.thread_id IS DISTINCT FROM p_thread OR a.channel_id IS DISTINCT FROM p_channel OR a.connection_id IS DISTINCT FROM p_connection OR a.membership_id IS DISTINCT FROM p_membership OR a.provider IS DISTINCT FROM p_provider OR a.action_kind IS DISTINCT FROM p_kind OR a.fingerprint IS DISTINCT FROM p_fingerprint THEN RETURN jsonb_build_object('state','conflict'); END IF;
 RETURN jsonb_build_object('state',CASE WHEN inserted THEN 'claimed' ELSE a.state END,'intent_id',a.id,'message_id',a.message_id);
END $$;
REVOKE ALL ON FUNCTION public.inbox_claim_action(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_claim_action(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text) TO service_role;

-- Exact source route for native reply/read/reaction; no fallback to legacy
-- message_id or sibling JID. Independently proven secondary routes may be
-- added later; until then fail closed for a message observed elsewhere.
CREATE FUNCTION public.inbox_native_action_target(p_account uuid,p_actor uuid,p_thread uuid,p_channel uuid,p_connection uuid,p_membership uuid,p_message uuid,p_read boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE c jsonb; r record;
BEGIN
 c=public.inbox_policy_context(p_account,p_actor,p_thread,p_channel,p_connection);
 IF c IS NULL OR c->>'membership_id' IS DISTINCT FROM p_membership::text OR c->>'ready' IS DISTINCT FROM 'true' OR c->>'can_operate' IS DISTINCT FROM 'true' OR c->>'recipient' IS NULL THEN RETURN NULL; END IF;
 SELECT m.id,m.provider_message_id,m.provider_chat_id,m.sender_type,im.provider INTO r
 FROM public.inbox_message_memberships im JOIN public.messages m ON m.id=im.message_id AND m.conversation_id=im.conversation_id AND m.connection_id=im.connection_id AND m.provider=im.provider
 WHERE im.account_id=p_account AND im.thread_id=p_thread AND im.channel_id=p_channel AND im.connection_id=p_connection AND im.membership_id=p_membership AND im.message_id=p_message
 AND m.provider_message_id IS NOT NULL AND length(btrim(m.provider_message_id)) BETWEEN 1 AND 512
 AND (NOT p_read OR m.sender_type='customer')
 AND ((im.evidence_kind='verified_current_ingress' AND m.sender_type='customer') OR (NOT p_read AND im.evidence_kind='verified_outbound_reservation' AND m.sender_type IN ('agent','bot') AND m.status IN ('sent','delivered','read','replied')))
 AND (im.provider<>'meta_cloud' OR EXISTS(SELECT 1 FROM public.inbox_verified_message_evidence e WHERE e.account_id=p_account AND e.message_id=m.id AND e.membership_id=p_membership AND e.native_message_id=m.provider_message_id AND e.meta_signed_sender=c->>'recipient') OR EXISTS(SELECT 1 FROM public.inbox_action_intents a WHERE a.account_id=p_account AND a.message_id=m.id AND a.membership_id=p_membership AND a.action_kind='send' AND a.state='accepted' AND a.recipient_hash=encode(sha256(convert_to(c->>'recipient','UTF8')),'hex') AND im.evidence_ref='inbox-action:v1:'||a.id::text))
 AND (im.provider<>'openwa' OR (m.provider_chat_id~'^[0-9]{5,20}@(c[.]us|lid)$' AND m.provider_chat_id=c->>'recipient'));
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('native_id',r.provider_message_id,'chat_id',r.provider_chat_id,'provider',r.provider);
END $$;
REVOKE ALL ON FUNCTION public.inbox_native_action_target(uuid,uuid,uuid,uuid,uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_native_action_target(uuid,uuid,uuid,uuid,uuid,uuid,uuid,boolean) TO service_role;

CREATE UNIQUE INDEX inbox_action_message_uidx ON public.inbox_action_intents(message_id) WHERE message_id IS NOT NULL;
-- Block browser forgery of reserved message keys or edits while dispatch
-- is in flight. Legacy keys and message paths retain their existing ACLs.
CREATE FUNCTION wacrm_internal.inbox_guard_action_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF current_setting('role',true) IN ('anon','authenticated') THEN
  IF TG_OP='INSERT' THEN
   IF NEW.outbound_idempotency_key LIKE 'inbox-action:%' THEN RAISE EXCEPTION 'INBOX_ACTION_SERVER_ONLY' USING ERRCODE='42501'; END IF;
  ELSE
   IF TG_OP='UPDATE' AND NEW.outbound_idempotency_key IS DISTINCT FROM OLD.outbound_idempotency_key AND (OLD.outbound_idempotency_key LIKE 'inbox-action:%' OR NEW.outbound_idempotency_key LIKE 'inbox-action:%') THEN RAISE EXCEPTION 'INBOX_ACTION_SERVER_ONLY' USING ERRCODE='42501'; END IF;
   IF EXISTS(SELECT 1 FROM public.inbox_action_intents WHERE message_id=OLD.id AND state IN ('pending','uncertain')) THEN RAISE EXCEPTION 'INBOX_ACTION_IN_FLIGHT' USING ERRCODE='42501'; END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_guard_action_source() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER inbox_guard_action_source BEFORE INSERT OR UPDATE OR DELETE ON public.messages FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_guard_action_source();

-- This private helper is used under a server-only, account-scoped
-- transaction. Re-check the frozen action, actor and exact active membership.
CREATE FUNCTION wacrm_internal.inbox_action_context(p_account uuid,p_actor uuid,p_intent uuid,p_recipient text)
RETURNS public.inbox_action_intents LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.inbox_action_intents%ROWTYPE; c jsonb;
BEGIN
 SELECT * INTO a FROM public.inbox_action_intents WHERE id=p_intent AND account_id=p_account AND actor_id=p_actor AND state='pending' FOR UPDATE;
 IF NOT FOUND OR p_recipient IS NULL OR a.recipient_hash<>encode(sha256(convert_to(p_recipient,'UTF8')),'hex') THEN RAISE EXCEPTION 'INBOX_ACTION_SCOPE' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.whatsapp_channel_memberships e JOIN public.whatsapp_connections w ON w.id=e.connection_id AND w.account_id=e.account_id AND w.provider=e.provider
 WHERE e.id=a.membership_id AND e.account_id=p_account AND e.channel_id=a.channel_id AND e.connection_id=a.connection_id AND e.valid_until IS NULL AND w.archived_at IS NULL FOR SHARE OF e,w;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_ACTION_EPOCH_CHANGED' USING ERRCODE='42501'; END IF;
 c=public.inbox_policy_context(p_account,p_actor,a.thread_id,a.channel_id,a.connection_id);
 IF c IS NULL OR c->>'membership_id' IS DISTINCT FROM a.membership_id::text OR c->>'conversation_id' IS DISTINCT FROM a.conversation_id::text OR c->>'provider' IS DISTINCT FROM a.provider OR c->>'recipient' IS DISTINCT FROM p_recipient OR c->>'can_operate' IS DISTINCT FROM 'true' OR c->>'ready' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'INBOX_ACTION_SCOPE' USING ERRCODE='42501'; END IF;
 RETURN a;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_action_context(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

-- Use the original messages row and its existing unique outbound-key index.
-- A journal claim alone is never permission to call a provider.
CREATE FUNCTION wacrm_internal.inbox_reserve_action_message(p_account uuid,p_actor uuid,p_intent uuid,p_recipient text,p_content_type text,p_content_text text,p_media_url text,p_template_name text,p_interactive jsonb,p_reply uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.inbox_action_intents%ROWTYPE; m uuid;
BEGIN
 a=wacrm_internal.inbox_action_context(p_account,p_actor,p_intent,p_recipient);
 IF a.action_kind<>'send' OR a.message_id IS NOT NULL OR a.dispatch_started_at IS NOT NULL OR p_content_type NOT IN ('text','image','video','audio','document','template','interactive') THEN RAISE EXCEPTION 'INBOX_ACTION_RESERVATION' USING ERRCODE='42501'; END IF;
 IF a.provider='openwa' AND (p_content_type IN ('template','interactive') OR NOT EXISTS(SELECT 1 FROM public.inbox_native_namespace_proofs n WHERE n.account_id=p_account AND n.channel_id=a.channel_id AND n.connection_id=a.connection_id AND n.membership_id=a.membership_id)) THEN RAISE EXCEPTION 'INBOX_ACTION_NATIVE_NAMESPACE' USING ERRCODE='42501'; END IF;
 IF p_reply IS NOT NULL AND public.inbox_native_action_target(p_account,p_actor,a.thread_id,a.channel_id,a.connection_id,a.membership_id,p_reply,false) IS NULL THEN RAISE EXCEPTION 'INBOX_ACTION_REPLY' USING ERRCODE='42501'; END IF;
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,media_url,template_name,interactive_payload,provider,connection_id,status,reply_to_message_id,outbound_idempotency_key)
 VALUES(a.conversation_id,'agent',p_content_type,p_content_text,p_media_url,p_template_name,p_interactive,a.provider,a.connection_id,'sending',p_reply,'inbox-action:'||a.id::text) RETURNING id INTO m;
 UPDATE public.inbox_action_intents SET message_id=m WHERE id=a.id AND account_id=p_account;
 RETURN m;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_reserve_action_message(uuid,uuid,uuid,text,text,text,text,text,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION wacrm_internal.inbox_reserve_action_message(uuid,uuid,uuid,text,text,text,text,text,jsonb,uuid) TO service_role;
CREATE FUNCTION public.inbox_reserve_action_message(p_account uuid,p_actor uuid,p_intent uuid,p_recipient text,p_content_type text,p_content_text text,p_media_url text,p_template_name text,p_interactive jsonb,p_reply uuid)
RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT wacrm_internal.inbox_reserve_action_message(p_account,p_actor,p_intent,p_recipient,p_content_type,p_content_text,p_media_url,p_template_name,p_interactive,p_reply)
$$;
REVOKE ALL ON FUNCTION public.inbox_reserve_action_message(uuid,uuid,uuid,text,text,text,text,text,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_reserve_action_message(uuid,uuid,uuid,text,text,text,text,text,jsonb,uuid) TO service_role;

-- Last irreversible boundary: one dispatch marker per intent. The app's
-- existing adapter calls this AFTER its own policy and pacing recheck.
CREATE FUNCTION wacrm_internal.inbox_begin_action_dispatch(p_account uuid,p_actor uuid,p_intent uuid,p_recipient text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.inbox_action_intents%ROWTYPE; c jsonb;
BEGIN
 a=wacrm_internal.inbox_action_context(p_account,p_actor,p_intent,p_recipient);
 IF a.dispatch_started_at IS NOT NULL OR (a.action_kind='send' AND NOT EXISTS(SELECT 1 FROM public.messages m WHERE m.id=a.message_id AND m.conversation_id=a.conversation_id AND m.connection_id=a.connection_id AND m.provider=a.provider AND m.outbound_idempotency_key='inbox-action:'||a.id::text AND m.status='sending' AND m.provider_message_id IS NULL)) THEN RETURN false; END IF;
 IF a.provider='meta_cloud' AND (a.action_kind='reaction' OR (a.action_kind='send' AND EXISTS(SELECT 1 FROM public.messages WHERE id=a.message_id AND (content_type<>'template' OR reply_to_message_id IS NOT NULL)))) THEN
  c=public.inbox_policy_context(p_account,p_actor,a.thread_id,a.channel_id,a.connection_id);
  IF c->>'last_inbound_at' IS NULL OR (c->>'last_inbound_at')::timestamptz<=clock_timestamp()-interval '24 hours' OR (c->>'last_inbound_at')::timestamptz>clock_timestamp() THEN RETURN false; END IF;
 END IF;
 UPDATE public.inbox_action_intents SET dispatch_started_at=clock_timestamp() WHERE id=a.id AND account_id=p_account;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_begin_action_dispatch(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION wacrm_internal.inbox_begin_action_dispatch(uuid,uuid,uuid,text) TO service_role;
CREATE FUNCTION public.inbox_begin_action_dispatch(p_account uuid,p_actor uuid,p_intent uuid,p_recipient text)
RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT wacrm_internal.inbox_begin_action_dispatch(p_account,p_actor,p_intent,p_recipient)
$$;
REVOKE ALL ON FUNCTION public.inbox_begin_action_dispatch(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_begin_action_dispatch(uuid,uuid,uuid,text) TO service_role;

-- Failures before the dispatch marker are proven local; afterward preserve
-- the original message reservation as uncertain. No automatic reset/resend.
CREATE FUNCTION wacrm_internal.inbox_fail_action(p_account uuid,p_actor uuid,p_intent uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.inbox_action_intents%ROWTYPE; s text;
BEGIN
 SELECT * INTO a FROM public.inbox_action_intents WHERE id=p_intent AND account_id=p_account AND actor_id=p_actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_ACTION_SCOPE' USING ERRCODE='42501'; END IF;
 IF a.state<>'pending' THEN RETURN a.state; END IF;
 s=CASE WHEN a.dispatch_started_at IS NULL THEN 'blocked' ELSE 'uncertain' END;
 IF s='blocked' AND a.message_id IS NOT NULL THEN
  UPDATE public.messages SET status='failed' WHERE id=a.message_id AND conversation_id=a.conversation_id AND connection_id=a.connection_id AND outbound_idempotency_key='inbox-action:'||a.id::text AND status='sending' AND provider_message_id IS NULL;
 END IF;
 UPDATE public.inbox_action_intents SET state=s,finished_at=clock_timestamp() WHERE id=a.id AND account_id=p_account;
 RETURN s;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_fail_action(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION wacrm_internal.inbox_fail_action(uuid,uuid,uuid) TO service_role;
CREATE FUNCTION public.inbox_fail_action(p_account uuid,p_actor uuid,p_intent uuid)
RETURNS text LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT wacrm_internal.inbox_fail_action(p_account,p_actor,p_intent)
$$;
REVOKE ALL ON FUNCTION public.inbox_fail_action(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_fail_action(uuid,uuid,uuid) TO service_role;

-- Provider acknowledgement, NOT a fabricated signed webhook receipt. A
-- successful response binds the native ID to the original frozen reservation.
CREATE FUNCTION wacrm_internal.inbox_complete_action_send(p_account uuid,p_actor uuid,p_intent uuid,p_native text,p_recipient text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.inbox_action_intents%ROWTYPE; m public.messages%ROWTYPE; t public.inbox_threads%ROWTYPE; ns text; canon public.inbox_canonical_messages%ROWTYPE; proof text; n bigint;
BEGIN
 SELECT * INTO a FROM public.inbox_action_intents WHERE id=p_intent AND account_id=p_account AND actor_id=p_actor AND action_kind='send' AND state='pending' AND dispatch_started_at IS NOT NULL FOR UPDATE;
 IF NOT FOUND OR p_native IS NULL OR length(btrim(p_native)) NOT BETWEEN 1 AND 512 OR p_recipient IS NULL OR a.recipient_hash<>encode(sha256(convert_to(p_recipient,'UTF8')),'hex') THEN RAISE EXCEPTION 'INBOX_ACTION_RESULT' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT m FROM public.messages WHERE id=a.message_id AND conversation_id=a.conversation_id AND connection_id=a.connection_id AND provider=a.provider AND sender_type='agent' AND outbound_idempotency_key='inbox-action:'||a.id::text AND status='sending' AND provider_message_id IS NULL FOR UPDATE;
 IF a.provider='openwa' THEN
  SELECT namespace_key INTO STRICT ns FROM public.inbox_native_namespace_proofs WHERE account_id=p_account AND channel_id=a.channel_id AND connection_id=a.connection_id AND membership_id=a.membership_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('inbox-outbound:'||p_account::text||':'||a.channel_id::text||':'||p_native,0));
  INSERT INTO public.inbox_canonical_messages(account_id,provider,channel_id,conversation_id,namespace_key,direction,native_message_id,origin_connection_id,origin_membership_id,source_message_id)
  VALUES(p_account,'openwa',a.channel_id,a.conversation_id,ns,'outbound',p_native,a.connection_id,a.membership_id,m.id)
  ON CONFLICT(account_id,provider,channel_id,namespace_key,direction,native_message_id) DO NOTHING;
  SELECT * INTO STRICT canon FROM public.inbox_canonical_messages WHERE account_id=p_account AND provider='openwa' AND channel_id=a.channel_id AND namespace_key=ns AND direction='outbound' AND native_message_id=p_native FOR UPDATE;
  IF canon.source_message_id IS DISTINCT FROM m.id OR canon.conversation_id<>a.conversation_id OR canon.origin_connection_id<>a.connection_id OR canon.origin_membership_id<>a.membership_id THEN RAISE EXCEPTION 'INBOX_ACTION_NATIVE_COLLISION' USING ERRCODE='23514'; END IF;
  INSERT INTO public.inbox_canonical_effects(canonical_id,account_id,provider,channel_id,state) VALUES(canon.id,p_account,'openwa',a.channel_id,'not_applicable') ON CONFLICT(canonical_id) DO NOTHING;
 END IF;
 UPDATE public.messages SET message_id=CASE WHEN EXISTS(SELECT 1 FROM public.messages m2 WHERE m2.conversation_id=a.conversation_id AND m2.message_id=p_native AND m2.id<>m.id) THEN NULL ELSE p_native END,
 provider_message_id=p_native,status='sent',provider_chat_id=CASE WHEN a.provider='openwa' AND p_recipient~'^[0-9]{5,20}@(c[.]us|lid)$' THEN p_recipient ELSE NULL END WHERE id=m.id;
 UPDATE public.inbox_action_intents SET state='accepted',finished_at=clock_timestamp() WHERE id=a.id AND account_id=p_account;
 proof='inbox-action:v1:'||a.id::text;
 INSERT INTO public.inbox_verified_message_evidence(message_id,account_id,conversation_id,provider,channel_id,connection_id,membership_id,native_message_id,observed_at,evidence_ref)
 VALUES(m.id,p_account,a.conversation_id,a.provider,a.channel_id,a.connection_id,a.membership_id,p_native,a.dispatch_started_at,proof);
 SELECT * INTO STRICT t FROM public.inbox_threads WHERE id=a.thread_id AND account_id=p_account AND channel_id=a.channel_id AND conversation_id=a.conversation_id FOR UPDATE;
 n=t.ingest_highwater+1;
 UPDATE public.inbox_threads SET ingest_highwater=n WHERE id=t.id AND account_id=p_account;
 INSERT INTO public.inbox_message_memberships(message_id,account_id,conversation_id,channel_id,thread_id,provider,connection_id,membership_id,evidence_kind,evidence_ref,ingest_sequence)
 VALUES(m.id,p_account,a.conversation_id,a.channel_id,a.thread_id,a.provider,a.connection_id,a.membership_id,'verified_outbound_reservation',proof,n);
 RETURN m.id;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_complete_action_send(uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION wacrm_internal.inbox_complete_action_send(uuid,uuid,uuid,text,text) TO service_role;
CREATE FUNCTION public.inbox_complete_action_send(p_account uuid,p_actor uuid,p_intent uuid,p_native text,p_recipient text)
RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT wacrm_internal.inbox_complete_action_send(p_account,p_actor,p_intent,p_native,p_recipient)
$$;
REVOKE ALL ON FUNCTION public.inbox_complete_action_send(uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_complete_action_send(uuid,uuid,uuid,text,text) TO service_role;

CREATE FUNCTION wacrm_internal.inbox_complete_native_action(p_account uuid,p_actor uuid,p_intent uuid,p_message uuid,p_emoji text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.inbox_action_intents%ROWTYPE;
BEGIN
 SELECT * INTO a FROM public.inbox_action_intents WHERE id=p_intent AND account_id=p_account AND actor_id=p_actor AND action_kind IN ('provider_read','reaction') AND state='pending' AND dispatch_started_at IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_message_memberships im WHERE im.message_id=p_message AND im.account_id=p_account AND im.thread_id=a.thread_id AND im.channel_id=a.channel_id AND im.connection_id=a.connection_id AND im.membership_id=a.membership_id) THEN RETURN false; END IF;
 IF a.action_kind='reaction' THEN
  IF a.provider<>'meta_cloud' OR p_emoji IS NULL OR length(p_emoji)>32 THEN RETURN false; END IF;
  IF p_emoji='' THEN DELETE FROM public.message_reactions WHERE message_id=p_message AND actor_type='agent' AND actor_id=p_actor;
  ELSE INSERT INTO public.message_reactions(message_id,conversation_id,actor_type,actor_id,emoji) VALUES(p_message,a.conversation_id,'agent',p_actor,p_emoji)
   ON CONFLICT(message_id,actor_type,actor_id) DO UPDATE SET emoji=excluded.emoji; END IF;
 END IF;
 UPDATE public.inbox_action_intents SET state='accepted',finished_at=clock_timestamp() WHERE id=a.id AND account_id=p_account;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_complete_native_action(uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION wacrm_internal.inbox_complete_native_action(uuid,uuid,uuid,uuid,text) TO service_role;
CREATE FUNCTION public.inbox_complete_native_action(p_account uuid,p_actor uuid,p_intent uuid,p_message uuid,p_emoji text)
RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT wacrm_internal.inbox_complete_native_action(p_account,p_actor,p_intent,p_message,p_emoji)
$$;
REVOKE ALL ON FUNCTION public.inbox_complete_native_action(uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_complete_native_action(uuid,uuid,uuid,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.inbox_guard_message_membership()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.evidence_kind='verified_current_ingress' AND NEW.provider='meta_cloud' THEN
  IF NOT EXISTS(SELECT 1 FROM public.inbox_verified_message_evidence e
   JOIN public.messages m ON m.id=e.message_id AND m.conversation_id=e.conversation_id
   WHERE e.message_id=NEW.message_id AND e.account_id=NEW.account_id AND e.conversation_id=NEW.conversation_id
   AND e.provider=NEW.provider AND e.channel_id=NEW.channel_id AND e.connection_id=NEW.connection_id AND e.membership_id=NEW.membership_id
   AND e.meta_signed_sender IS NOT NULL AND e.evidence_ref='meta-signed-ingress:v1:'||NEW.message_id::text AND e.evidence_ref=NEW.evidence_ref
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
 IF NEW.evidence_kind='verified_outbound_reservation' AND NEW.evidence_ref LIKE 'inbox-action:v1:%' THEN
  IF NOT EXISTS(SELECT 1 FROM public.inbox_action_intents a JOIN public.messages m ON m.id=a.message_id AND m.conversation_id=a.conversation_id
   JOIN public.inbox_verified_message_evidence e ON e.message_id=m.id AND e.account_id=a.account_id AND e.membership_id=a.membership_id AND e.native_message_id=m.provider_message_id
   WHERE NEW.evidence_ref='inbox-action:v1:'||a.id::text AND a.account_id=NEW.account_id AND a.message_id=NEW.message_id AND a.thread_id=NEW.thread_id
    AND a.conversation_id=NEW.conversation_id AND a.channel_id=NEW.channel_id AND a.connection_id=NEW.connection_id AND a.membership_id=NEW.membership_id AND a.provider=NEW.provider
    AND a.state='accepted' AND a.action_kind='send' AND a.dispatch_started_at IS NOT NULL AND m.sender_type='agent' AND m.outbound_idempotency_key='inbox-action:'||a.id::text AND m.connection_id=a.connection_id AND m.provider=a.provider AND e.evidence_ref=NEW.evidence_ref)
   THEN RAISE EXCEPTION 'INBOX_ACTION_OUTBOUND_PROOF_REQUIRED' USING ERRCODE='23514'; END IF;
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


CREATE OR REPLACE FUNCTION public.inbox_commit_outbound_echo(p_account uuid,p_connection uuid,p_event text,p_token uuid,p_session text,p_instance text,p_conversation uuid,p_native text,p_native_proven boolean,p_chat text,p_peer_phone text,p_kind text,p_text text,p_mime text,p_at timestamptz,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE r public.whatsapp_webhook_event_receipts%ROWTYPE; ep public.whatsapp_channel_memberships%ROWTYPE; ns text; c public.inbox_canonical_messages%ROWTYPE; src public.messages%ROWTYPE; t public.inbox_threads%ROWTYPE; d jsonb; src_id uuid; reason text; n bigint;
BEGIN
 SELECT * INTO r FROM public.whatsapp_webhook_event_receipts WHERE account_id=p_account AND connection_id=p_connection AND provider='openwa' AND provider_event_id=p_event AND processing_token=p_token AND p_token IS NOT NULL AND processed_at IS NULL AND processing_started_at>=clock_timestamp()-interval '90 seconds' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_SIGNED_RECEIPT_REQUIRED' USING ERRCODE='42501'; END IF;
 ep=public.inbox_active_observation_epoch(p_account,p_connection,p_session,p_instance,r.received_at);
 SELECT namespace_key INTO ns FROM public.inbox_native_namespace_proofs WHERE account_id=p_account AND membership_id=ep.id AND channel_id=ep.channel_id;
 IF ns IS NULL OR p_native_proven IS DISTINCT FROM true OR p_native IS NULL OR length(btrim(p_native)) NOT BETWEEN 1 AND 512
 OR p_chat IS NULL OR p_chat !~ '^[0-9]{5,20}@(c[.]us|lid)$' OR p_peer_phone IS NULL OR p_peer_phone !~ '^[1-9][0-9]{6,14}$'
 OR (p_chat LIKE '%@c.us' AND split_part(p_chat,'@',1)<>p_peer_phone) OR (p_chat LIKE '%@lid' AND split_part(p_chat,'@',1)=p_peer_phone)
 OR p_kind NOT IN ('text','image','video','document','audio') OR p_at IS NULL OR p_at>clock_timestamp()+interval '5 minutes'
 THEN reason='outbound_echo_unproven'; END IF;
 IF reason IS NULL THEN
  PERFORM 1 FROM public.conversations cv JOIN public.contacts ct ON ct.id=cv.contact_id AND ct.account_id=cv.account_id
  WHERE cv.account_id=p_account AND cv.id=p_conversation AND regexp_replace(ct.phone,'[^0-9]','','g')=p_peer_phone FOR UPDATE OF cv;
  IF NOT FOUND THEN reason='outbound_echo_unproven'; END IF;
 END IF;
 IF reason IS NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('inbox-outbound:'||p_account::text||':'||ep.channel_id::text||':'||p_native,0));
  SELECT * INTO c FROM public.inbox_canonical_messages WHERE account_id=p_account AND provider='openwa' AND channel_id=ep.channel_id AND namespace_key=ns AND direction='outbound' AND native_message_id=p_native FOR UPDATE;
  SELECT m.* INTO src FROM public.messages m JOIN public.conversations cv ON cv.id=m.conversation_id AND cv.account_id=p_account WHERE m.provider='openwa' AND m.connection_id=p_connection AND m.provider_message_id=p_native FOR UPDATE OF m;
  IF c.id IS NOT NULL THEN
   IF c.conversation_id<>p_conversation OR c.source_message_id IS NULL OR (src.id IS NOT NULL AND src.id<>c.source_message_id)
   OR NOT EXISTS(SELECT 1 FROM public.inbox_message_memberships im WHERE im.account_id=p_account AND im.message_id=c.source_message_id AND im.evidence_kind='verified_outbound_reservation' AND (im.evidence_ref=c.id::text OR EXISTS(SELECT 1 FROM public.inbox_action_intents a WHERE a.account_id=p_account AND a.message_id=c.source_message_id AND a.state='accepted' AND a.action_kind='send' AND a.channel_id=ep.channel_id AND a.connection_id=c.origin_connection_id AND a.membership_id=c.origin_membership_id AND im.evidence_ref='inbox-action:v1:'||a.id::text)))
   THEN reason='outbound_echo_unproven'; END IF;
  ELSIF src.id IS NOT NULL THEN
   IF src.conversation_id<>p_conversation OR src.sender_type NOT IN ('agent','bot') OR src.created_at IS NULL OR src.created_at<ep.valid_from OR src.status NOT IN ('sent','delivered','read')
   OR (src.provider_chat_id IS NOT NULL AND src.provider_chat_id<>p_chat) OR src.content_type<>p_kind OR EXISTS(SELECT 1 FROM public.inbox_message_memberships WHERE message_id=src.id)
   THEN reason='outbound_echo_unproven'; END IF;
  ELSIF NOT ep.is_primary OR EXISTS(
   SELECT 1 FROM public.messages m JOIN public.whatsapp_channel_memberships em ON em.account_id=p_account AND em.channel_id=ep.channel_id AND em.connection_id=m.connection_id AND em.valid_until IS NULL
   WHERE m.conversation_id=p_conversation AND m.provider='openwa' AND m.sender_type IN ('agent','bot') AND (m.status='sending' OR m.provider_message_id=p_native))
  THEN reason='outbound_echo_unproven'; END IF;
 END IF;
 IF reason IS NOT NULL THEN
  PERFORM public.inbox_hold_signed_observation(p_account,p_connection,p_event,p_token,p_session,p_instance,reason,p_payload);
  RETURN jsonb_build_object('state','review');
 END IF;
 d=public.inbox_record_canonical_observation(p_account,p_connection,p_event,p_token,p_conversation,p_session,p_instance,p_native,true,'outbound',p_payload);
 IF d->>'state'='review' THEN RETURN d; END IF;
 SELECT * INTO STRICT c FROM public.inbox_canonical_messages WHERE account_id=p_account AND id=(d->>'canonicalId')::uuid FOR UPDATE;
 IF c.source_message_id IS NOT NULL THEN RETURN jsonb_build_object('state','existing','messageId',c.source_message_id,'conversationId',c.conversation_id); END IF;
 IF c.origin_connection_id<>p_connection OR c.origin_membership_id<>ep.id THEN RAISE EXCEPTION 'INBOX_ECHO_ORIGIN_CHANGED' USING ERRCODE='23514'; END IF;
 src_id=src.id;
 IF src_id IS NULL THEN
  INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,media_type,message_id,provider,connection_id,provider_message_id,provider_chat_id,status,created_at)
  VALUES(p_conversation,'agent',p_kind,p_text,p_mime,p_native,'openwa',p_connection,p_native,p_chat,'sent',p_at) ON CONFLICT DO NOTHING RETURNING id INTO src_id;
  IF src_id IS NULL AND EXISTS(SELECT 1 FROM public.messages m WHERE m.conversation_id=p_conversation AND m.message_id=p_native AND m.provider IS NOT NULL AND m.connection_id IS NOT NULL AND (m.provider<>'openwa' OR m.connection_id<>p_connection))
   AND NOT EXISTS(SELECT 1 FROM public.messages WHERE provider='openwa' AND connection_id=p_connection AND provider_message_id=p_native) THEN
   INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,media_type,message_id,provider,connection_id,provider_message_id,provider_chat_id,status,created_at)
   VALUES(p_conversation,'agent',p_kind,p_text,p_mime,NULL,'openwa',p_connection,p_native,p_chat,'sent',p_at) ON CONFLICT DO NOTHING RETURNING id INTO src_id;
  END IF;
 END IF;
 IF src_id IS NULL THEN
  PERFORM public.inbox_hold_signed_observation(p_account,p_connection,p_event,p_token,p_session,p_instance,'outbound_echo_unproven',p_payload);
  UPDATE public.inbox_canonical_effects SET state='review' WHERE account_id=p_account AND canonical_id=c.id;
  RETURN jsonb_build_object('state','review');
 END IF;
 UPDATE public.inbox_canonical_messages SET source_message_id=src_id WHERE account_id=p_account AND id=c.id;
 INSERT INTO public.inbox_threads(account_id,conversation_id,channel_id,provider) VALUES(p_account,p_conversation,ep.channel_id,'openwa') ON CONFLICT(account_id,conversation_id,channel_id) DO NOTHING;
 SELECT * INTO STRICT t FROM public.inbox_threads WHERE account_id=p_account AND conversation_id=p_conversation AND channel_id=ep.channel_id FOR UPDATE;
 n=t.ingest_highwater+1;
 UPDATE public.inbox_threads SET ingest_highwater=n WHERE account_id=p_account AND id=t.id;
 INSERT INTO public.inbox_message_memberships(message_id,account_id,conversation_id,channel_id,thread_id,provider,connection_id,membership_id,evidence_kind,evidence_ref,ingest_sequence)
 VALUES(src_id,p_account,p_conversation,ep.channel_id,t.id,'openwa',p_connection,ep.id,'verified_outbound_reservation',c.id::text,n);
 UPDATE public.inbox_canonical_effects SET state='not_applicable' WHERE account_id=p_account AND canonical_id=c.id AND state='awaiting_source';
 UPDATE public.conversations SET last_message_text=CASE WHEN last_message_at IS NULL OR p_at>=last_message_at THEN coalesce(p_text,'['||p_kind||']') ELSE last_message_text END,
 last_message_at=greatest(last_message_at,p_at),updated_at=clock_timestamp() WHERE id=p_conversation AND account_id=p_account;
 RETURN jsonb_build_object('state',CASE WHEN src.id IS NULL THEN 'inserted' ELSE 'existing' END,'messageId',src_id,'conversationId',p_conversation);
END $$;
REVOKE ALL ON FUNCTION public.inbox_commit_outbound_echo(uuid,uuid,text,uuid,text,text,uuid,text,boolean,text,text,text,text,text,timestamptz,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_commit_outbound_echo(uuid,uuid,text,uuid,text,text,uuid,text,boolean,text,text,text,text,text,timestamptz,jsonb) TO service_role;


-- Explicit outbound-only opening for an existing CRM contact; no send or
-- automatic selection. The legacy parent remains one per account/contact.
CREATE FUNCTION wacrm_internal.inbox_open_explicit_thread(p_account uuid,p_actor uuid,p_contact uuid,p_channel uuid,p_connection uuid,p_membership uuid,p_provider text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE parent_id uuid; thread_id uuid; c jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE account_id=p_account AND user_id=p_actor AND account_role::text IN ('owner','admin','agent')) THEN RAISE EXCEPTION 'INBOX_ACTION_ACTOR' USING ERRCODE='42501'; END IF;
 IF p_provider NOT IN ('openwa','meta_cloud') OR p_provider IS NULL OR NOT EXISTS(SELECT 1 FROM public.contacts WHERE account_id=p_account AND id=p_contact AND regexp_replace(phone,'[^0-9]','','g')~'^[1-9][0-9]{6,14}$') THEN RAISE EXCEPTION 'INBOX_ACTION_CONTACT' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.whatsapp_channel_memberships e JOIN public.whatsapp_connections w ON w.id=e.connection_id AND w.account_id=e.account_id AND w.provider=e.provider WHERE e.account_id=p_account AND e.id=p_membership AND e.channel_id=p_channel AND e.connection_id=p_connection AND e.provider=p_provider AND e.valid_until IS NULL AND w.archived_at IS NULL FOR SHARE OF e,w;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_ACTION_SCOPE' USING ERRCODE='42501'; END IF;
 INSERT INTO public.conversations(user_id,account_id,contact_id,status,unread_count) VALUES(p_actor,p_account,p_contact,'pending',0) ON CONFLICT(account_id,contact_id) DO NOTHING;
 SELECT id INTO STRICT parent_id FROM public.conversations WHERE account_id=p_account AND contact_id=p_contact;
 INSERT INTO public.inbox_threads(account_id,conversation_id,channel_id,provider) VALUES(p_account,parent_id,p_channel,p_provider) ON CONFLICT(account_id,conversation_id,channel_id) DO NOTHING;
 SELECT id INTO STRICT thread_id FROM public.inbox_threads WHERE account_id=p_account AND conversation_id=parent_id AND channel_id=p_channel;
 c=public.inbox_policy_context(p_account,p_actor,thread_id,p_channel,p_connection);
 IF c IS NULL OR c->>'membership_id' IS DISTINCT FROM p_membership::text OR c->>'ready' IS DISTINCT FROM 'true' OR c->>'can_operate' IS DISTINCT FROM 'true' OR c->>'recipient' IS NULL THEN RAISE EXCEPTION 'INBOX_ACTION_ROUTE' USING ERRCODE='42501'; END IF;
 RETURN thread_id;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_open_explicit_thread(uuid,uuid,uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION wacrm_internal.inbox_open_explicit_thread(uuid,uuid,uuid,uuid,uuid,uuid,text) TO service_role;
CREATE FUNCTION public.inbox_open_explicit_thread(p_account uuid,p_actor uuid,p_contact uuid,p_channel uuid,p_connection uuid,p_membership uuid,p_provider text)
RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT wacrm_internal.inbox_open_explicit_thread(p_account,p_actor,p_contact,p_channel,p_connection,p_membership,p_provider)
$$;
REVOKE ALL ON FUNCTION public.inbox_open_explicit_thread(uuid,uuid,uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_open_explicit_thread(uuid,uuid,uuid,uuid,uuid,uuid,text) TO service_role;
