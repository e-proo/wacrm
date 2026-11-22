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
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','blocked','uncertain')),
 message_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
 UNIQUE(account_id,request_key),
 CHECK((state='pending')=(finished_at IS NULL))
);
ALTER TABLE public.inbox_action_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbox_action_intents FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.inbox_action_intents TO service_role;
GRANT UPDATE(state,message_id,finished_at) ON public.inbox_action_intents TO service_role;
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
  INSERT INTO public.inbox_action_intents(account_id,actor_id,request_key,thread_id,conversation_id,channel_id,connection_id,membership_id,provider,action_kind,fingerprint)
  VALUES(p_account,p_actor,p_key,p_thread,(c->>'conversation_id')::uuid,p_channel,p_connection,p_membership,p_provider,p_kind,p_fingerprint)
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
 AND (im.provider<>'meta_cloud' OR EXISTS(SELECT 1 FROM public.inbox_verified_message_evidence e WHERE e.account_id=p_account AND e.message_id=m.id AND e.membership_id=p_membership AND e.native_message_id=m.provider_message_id AND e.meta_signed_sender=c->>'recipient'))
 AND (im.provider<>'openwa' OR (m.provider_chat_id~'^[0-9]{5,20}@(c[.]us|lid)$' AND m.provider_chat_id=c->>'recipient'));
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('native_id',r.provider_message_id,'chat_id',r.provider_chat_id,'provider',r.provider);
END $$;
REVOKE ALL ON FUNCTION public.inbox_native_action_target(uuid,uuid,uuid,uuid,uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_native_action_target(uuid,uuid,uuid,uuid,uuid,uuid,uuid,boolean) TO service_role;
