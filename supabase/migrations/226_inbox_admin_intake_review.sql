-- FIX-03: evidence-bound history-only recovery and explicit administrative
-- settlement. Never replay a webhook, claim business effects or infer proof.
CREATE TABLE public.inbox_intake_review_settlements (
 receipt_id uuid PRIMARY KEY REFERENCES public.inbox_canonical_intake_review(receipt_id) ON DELETE RESTRICT,
 account_id uuid NOT NULL,connection_id uuid NOT NULL,provider text NOT NULL CHECK(provider='openwa'),
 actor_id uuid NOT NULL,request_id uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('restored_history','duplicate_confirmed','closed_unverified')),
 reason text NOT NULL CHECK(reason IN ('proven_history_only','exact_existing_observation','insufficient_evidence')),
 canonical_id uuid,message_id uuid,settled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(account_id,connection_id,provider,receipt_id) REFERENCES public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,id),
 UNIQUE(account_id,request_id),
 CHECK((outcome='closed_unverified' AND reason='insufficient_evidence' AND canonical_id IS NULL AND message_id IS NULL)
 OR (outcome='restored_history' AND reason='proven_history_only' AND canonical_id IS NOT NULL AND message_id IS NOT NULL)
 OR (outcome='duplicate_confirmed' AND reason='exact_existing_observation' AND canonical_id IS NOT NULL AND message_id IS NOT NULL))
);
ALTER TABLE public.inbox_intake_review_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbox_intake_review_settlements FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.inbox_intake_review_settlements TO service_role;
CREATE POLICY inbox_review_settlement_service ON public.inbox_intake_review_settlements FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE INDEX inbox_review_account_status_page ON public.inbox_canonical_intake_review(account_id,(resolved_at IS NULL),receipt_id);
-- Shared evaluator for list and locked writer. Does not expose source content,
-- phone, native IDs, session IDs or any credentials. Caller is server-only.
CREATE FUNCTION public.inbox_review_decision(p_account uuid,p_receipt uuid)
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
 IF r.processed_at IS NULL OR r.processing_started_at IS NOT NULL OR r.processing_error IS NOT NULL
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
 IF cm.source_message_id IS NOT NULL AND cm.first_source_message_id=cm.source_message_id
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
 OR np.scope_kind IS DISTINCT FROM 'single_connection' OR np.engine IS DISTINCT FROM 'whatsapp-web.js' OR np.gateway_version IS DISTINCT FROM '0.29.1'
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
REVOKE ALL ON FUNCTION public.inbox_review_decision(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_review_decision(uuid,uuid) TO service_role;

CREATE FUNCTION public.inbox_admin_intake_review_page(p_account uuid,p_actor uuid,p_closed boolean,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=p_actor AND account_id=p_account AND account_role IN ('owner','admin'))
 THEN RAISE EXCEPTION 'INBOX_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_closed IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'INBOX_BAD_LIMIT' USING ERRCODE='22023'; END IF;
 WITH page AS MATERIALIZED(SELECT q.* FROM public.inbox_canonical_intake_review q WHERE q.account_id=p_account AND q.provider='openwa'
 AND (q.resolved_at IS NOT NULL)=p_closed AND (p_after IS NULL OR q.receipt_id>p_after) ORDER BY q.receipt_id LIMIT (p_limit+1))
 SELECT jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object(
 'id',q.receipt_id,'connection_id',q.connection_id,'display_name',left(c.display_name,160),'reason',q.reason,'created_at',q.created_at,'resolved_at',q.resolved_at,
 'decision',CASE WHEN p_closed THEN 'closed' ELSE public.inbox_review_decision(p_account,q.receipt_id) END,
 'outcome',CASE WHEN p_closed THEN coalesce(s.outcome,'system_resolved') END,
 'preview',CASE WHEN q.normalized_payload->>'type'='text' AND jsonb_typeof(q.normalized_payload->'text')='string' THEN left(q.normalized_payload->>'text',160) END,
 'message_kind',CASE WHEN q.normalized_payload->>'type' IN ('text','image','video','audio','document','reaction','sticker','location','interactive','template') THEN q.normalized_payload->>'type' ELSE 'other' END
 ) ORDER BY q.receipt_id),'[]'::jsonb)) INTO result
 FROM page q JOIN public.whatsapp_connections c ON c.account_id=q.account_id AND c.provider=q.provider AND c.id=q.connection_id
 LEFT JOIN public.inbox_intake_review_settlements s ON s.receipt_id=q.receipt_id AND s.account_id=q.account_id AND s.connection_id=q.connection_id AND s.provider=q.provider;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.inbox_admin_intake_review_page(uuid,uuid,boolean,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_admin_intake_review_page(uuid,uuid,boolean,uuid,integer) TO service_role;

CREATE FUNCTION public.inbox_admin_settle_intake_review(p_account uuid,p_actor uuid,p_receipt uuid,p_action text,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE q public.inbox_canonical_intake_review%ROWTYPE;r public.whatsapp_webhook_event_receipts%ROWTYPE;
 o public.inbox_message_connection_observations%ROWTYPE;cm public.inbox_canonical_messages%ROWTYPE;
 t public.inbox_threads%ROWTYPE;s public.inbox_intake_review_settlements%ROWTYPE;
 decision text; outcome text; why text; mid uuid; can_id uuid; proof_ref text; at_time timestamptz;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=p_actor AND account_id=p_account AND account_role IN ('owner','admin'))
 THEN RAISE EXCEPTION 'INBOX_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_receipt IS NULL OR p_request IS NULL OR p_action IS NULL OR p_action NOT IN ('restore','duplicate','close_unverified')
 THEN RAISE EXCEPTION 'INBOX_BAD_REVIEW_ACTION' USING ERRCODE='22023'; END IF;
 -- Lock signed receipt before review, matching canonical ingress order.
 SELECT * INTO r FROM public.whatsapp_webhook_event_receipts WHERE id=p_receipt AND account_id=p_account AND provider='openwa' FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','conflict'); END IF;
 SELECT * INTO q FROM public.inbox_canonical_intake_review WHERE receipt_id=p_receipt AND account_id=p_account AND provider='openwa' AND connection_id=r.connection_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','conflict'); END IF;
 SELECT * INTO s FROM public.inbox_intake_review_settlements WHERE account_id=p_account AND receipt_id=p_receipt AND connection_id=q.connection_id AND provider=q.provider;
 IF FOUND THEN
  IF s.request_id=p_request AND s.actor_id=p_actor AND ((p_action='restore' AND s.outcome='restored_history') OR (p_action='duplicate' AND s.outcome='duplicate_confirmed') OR (p_action='close_unverified' AND s.outcome='closed_unverified'))
  THEN RETURN jsonb_build_object('state','settled','outcome',s.outcome); END IF;
  RETURN jsonb_build_object('state','conflict');
 END IF;
 IF q.resolved_at IS NOT NULL THEN RETURN jsonb_build_object('state','conflict'); END IF;
 IF EXISTS(SELECT 1 FROM public.inbox_intake_review_settlements WHERE account_id=p_account AND request_id=p_request) THEN RETURN jsonb_build_object('state','conflict'); END IF;
 SELECT * INTO o FROM public.inbox_message_connection_observations WHERE receipt_id=q.receipt_id AND account_id=q.account_id AND connection_id=q.connection_id AND provider=q.provider;
 IF FOUND THEN
  SELECT * INTO STRICT cm FROM public.inbox_canonical_messages WHERE id=o.canonical_id AND account_id=o.account_id AND provider=o.provider AND channel_id=o.channel_id FOR UPDATE;
  PERFORM 1 FROM public.inbox_canonical_effects WHERE canonical_id=cm.id AND account_id=cm.account_id AND provider=cm.provider AND channel_id=cm.channel_id FOR UPDATE;
  PERFORM 1 FROM public.whatsapp_channel_memberships WHERE account_id=p_account AND id=o.membership_id AND channel_id=o.channel_id AND connection_id=o.connection_id AND provider=o.provider FOR SHARE;
  PERFORM 1 FROM public.conversations WHERE account_id=p_account AND id=cm.conversation_id FOR UPDATE;
  PERFORM 1 FROM public.contacts ct JOIN public.conversations cv ON cv.contact_id=ct.id AND cv.account_id=ct.account_id WHERE cv.account_id=p_account AND cv.id=cm.conversation_id FOR SHARE OF ct;
  IF cm.source_message_id IS NOT NULL THEN PERFORM 1 FROM public.messages WHERE id=cm.source_message_id AND conversation_id=cm.conversation_id FOR SHARE; END IF;
 END IF;
 decision=public.inbox_review_decision(p_account,p_receipt);
 IF decision='busy' THEN RETURN jsonb_build_object('state','busy'); END IF;
 IF p_action='close_unverified' AND decision='unverified' THEN
  outcome='closed_unverified';why='insufficient_evidence';
 ELSIF p_action='duplicate' AND decision='duplicate' THEN
  outcome='duplicate_confirmed';why='exact_existing_observation';mid=cm.source_message_id;can_id=cm.id;
 ELSIF p_action='restore' AND decision='restore' THEN
  at_time=to_timestamp((q.normalized_payload->>'timestamp')::bigint);
  INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,message_id,provider,connection_id,provider_message_id,provider_chat_id,status,created_at)
  VALUES(cm.conversation_id,'customer','text',q.normalized_payload->>'text',cm.native_message_id,'openwa',cm.origin_connection_id,cm.native_message_id,q.normalized_payload->>'chatId','delivered',at_time)
  ON CONFLICT DO NOTHING RETURNING id INTO mid;
  IF mid IS NULL THEN RETURN jsonb_build_object('state','conflict'); END IF;
  can_id=cm.id;proof_ref='review-history:'||q.receipt_id::text;
  UPDATE public.inbox_canonical_messages SET source_message_id=mid WHERE account_id=p_account AND id=cm.id;
  -- Permanent terminal, no claim or pending work. Historical association
  -- intentionally never opens a trusted inbound window or increments unread.
  UPDATE public.inbox_canonical_effects SET state='not_applicable' WHERE account_id=p_account AND canonical_id=cm.id AND state='awaiting_source';
  IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_EFFECT_CHANGED' USING ERRCODE='23514'; END IF;
  INSERT INTO public.inbox_verified_message_evidence(message_id,account_id,conversation_id,provider,channel_id,connection_id,membership_id,native_message_id,observed_at,evidence_ref)
  VALUES(mid,p_account,cm.conversation_id,'openwa',cm.channel_id,cm.origin_connection_id,cm.origin_membership_id,cm.native_message_id,r.received_at,proof_ref);
  INSERT INTO public.inbox_threads(account_id,conversation_id,channel_id,provider) VALUES(p_account,cm.conversation_id,cm.channel_id,'openwa') ON CONFLICT(account_id,conversation_id,channel_id) DO NOTHING;
  SELECT * INTO STRICT t FROM public.inbox_threads WHERE account_id=p_account AND conversation_id=cm.conversation_id AND channel_id=cm.channel_id FOR UPDATE;
  UPDATE public.inbox_threads SET ingest_highwater=t.ingest_highwater+1 WHERE account_id=p_account AND id=t.id;
  INSERT INTO public.inbox_message_memberships(message_id,account_id,conversation_id,channel_id,thread_id,provider,connection_id,membership_id,evidence_kind,evidence_ref,ingest_sequence,read_before_move)
  VALUES(mid,p_account,cm.conversation_id,cm.channel_id,t.id,'openwa',cm.origin_connection_id,cm.origin_membership_id,'verified_historical_epoch',proof_ref,t.ingest_highwater+1,true);
  UPDATE public.conversations SET last_message_text=CASE WHEN last_message_at IS NULL OR at_time>=last_message_at THEN q.normalized_payload->>'text' ELSE last_message_text END,last_message_at=greatest(last_message_at,at_time),updated_at=clock_timestamp()
  WHERE account_id=p_account AND id=cm.conversation_id;
  outcome='restored_history';why='proven_history_only';
 ELSE RETURN jsonb_build_object('state','not_eligible'); END IF;
 INSERT INTO public.inbox_intake_review_settlements(receipt_id,account_id,connection_id,provider,actor_id,request_id,outcome,reason,canonical_id,message_id)
 VALUES(q.receipt_id,p_account,q.connection_id,'openwa',p_actor,p_request,outcome,why,can_id,mid);
 UPDATE public.inbox_canonical_intake_review SET resolved_at=clock_timestamp() WHERE account_id=p_account AND receipt_id=q.receipt_id AND resolved_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REVIEW_CHANGED' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('state','settled','outcome',outcome);
END $$;
REVOKE ALL ON FUNCTION public.inbox_admin_settle_intake_review(uuid,uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_admin_settle_intake_review(uuid,uuid,uuid,text,uuid) TO service_role;
COMMENT ON TABLE public.inbox_intake_review_settlements IS 'Append-only administrative outcome; closed_unverified is not delivery proof. Original review and signed receipt remain immutable evidence.';
