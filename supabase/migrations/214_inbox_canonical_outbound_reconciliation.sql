-- SOF-89.07: signed own-send evidence and monotonic ACK, without dispatch.
ALTER TABLE public.inbox_canonical_effects DROP CONSTRAINT inbox_canonical_effects_state_check;
ALTER TABLE public.inbox_canonical_effects ADD CONSTRAINT inbox_canonical_effects_state_check CHECK(state IN ('awaiting_source','pending','claimed','returned','review','not_applicable'));
ALTER TABLE public.inbox_canonical_effects DROP CONSTRAINT inbox_effect_claim_consistency;
ALTER TABLE public.inbox_canonical_effects ADD CONSTRAINT inbox_effect_claim_consistency CHECK(
 (state IN ('awaiting_source','pending','not_applicable') AND claim_token IS NULL AND claimed_at IS NULL AND returned_at IS NULL)
 OR (state='claimed' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND returned_at IS NULL)
 OR (state='returned' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND returned_at IS NOT NULL) OR state='review');
CREATE OR REPLACE FUNCTION public.inbox_guard_message_membership()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
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


-- Same immutable membership and namespace must cover the time of receipt.
CREATE FUNCTION public.inbox_active_observation_epoch(p_account uuid,p_connection uuid,p_session text,p_instance text,p_received timestamptz)
RETURNS public.whatsapp_channel_memberships LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE ep public.whatsapp_channel_memberships%ROWTYPE;
BEGIN
 SELECT m.* INTO ep FROM public.whatsapp_channel_memberships m JOIN public.whatsapp_connections wc ON wc.id=m.connection_id AND wc.account_id=m.account_id AND wc.provider=m.provider
 JOIN public.inbox_native_namespace_proofs np ON np.membership_id=m.id AND np.account_id=m.account_id AND np.channel_id=m.channel_id
 WHERE m.account_id=p_account AND m.connection_id=p_connection AND m.provider='openwa' AND m.valid_until IS NULL AND m.valid_from<=p_received
 AND m.session_snapshot=p_session AND m.instance_snapshot IS NOT DISTINCT FROM p_instance AND wc.session_id=p_session AND wc.instance_id IS NOT DISTINCT FROM p_instance
 AND wc.archived_at IS NULL AND wc.status IN ('ready','connected') FOR SHARE OF m,wc;
 RETURN ep;
END $$;
REVOKE ALL ON FUNCTION public.inbox_active_observation_epoch(uuid,uuid,text,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_active_observation_epoch(uuid,uuid,text,text,timestamptz) TO service_role;

CREATE FUNCTION public.inbox_commit_outbound_echo(p_account uuid,p_connection uuid,p_event text,p_token uuid,p_session text,p_instance text,p_conversation uuid,p_native text,p_native_proven boolean,p_chat text,p_peer_phone text,p_kind text,p_text text,p_mime text,p_at timestamptz,p_payload jsonb)
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
   OR NOT EXISTS(SELECT 1 FROM public.inbox_message_memberships im WHERE im.account_id=p_account AND im.message_id=c.source_message_id AND im.evidence_kind='verified_outbound_reservation' AND im.evidence_ref=c.id::text)
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

CREATE TABLE public.inbox_canonical_ack_observations (
 receipt_id uuid PRIMARY KEY, account_id uuid NOT NULL, provider text NOT NULL DEFAULT 'openwa' CHECK(provider='openwa'), connection_id uuid NOT NULL, channel_id uuid NOT NULL, membership_id uuid NOT NULL,
 canonical_id uuid, native_message_id text NOT NULL, observed_status text NOT NULL CHECK(observed_status IN ('sent','delivered','read','failed')), observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(account_id,connection_id,provider,receipt_id) REFERENCES public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,id),
 FOREIGN KEY(account_id,provider,channel_id,connection_id,membership_id) REFERENCES public.whatsapp_channel_memberships(account_id,provider,channel_id,connection_id,id),
 FOREIGN KEY(account_id,provider,channel_id,canonical_id) REFERENCES public.inbox_canonical_messages(account_id,provider,channel_id,id) ON DELETE CASCADE
);
ALTER TABLE public.inbox_canonical_ack_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbox_canonical_ack_observations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.inbox_canonical_ack_observations TO service_role;
CREATE POLICY inbox_service_only ON public.inbox_canonical_ack_observations FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE INDEX inbox_ack_account_native ON public.inbox_canonical_ack_observations(account_id,channel_id,native_message_id,observed_at);
CREATE FUNCTION public.inbox_status_forward(p_old text,p_new text) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN p_new='failed' THEN p_old IN ('pending','sending','sent') WHEN p_old='failed' THEN false
 ELSE coalesce(array_position(ARRAY['pending','sending','sent','delivered','read','replied'],p_new),0)>coalesce(array_position(ARRAY['pending','sending','sent','delivered','read','replied'],p_old),0) END
$$;
REVOKE ALL ON FUNCTION public.inbox_status_forward(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_status_forward(text,text) TO service_role;
CREATE FUNCTION public.inbox_apply_canonical_ack(p_account uuid,p_connection uuid,p_event text,p_token uuid,p_session text,p_instance text,p_native text,p_status text,p_job uuid DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE r public.whatsapp_webhook_event_receipts%ROWTYPE; ep public.whatsapp_channel_memberships%ROWTYPE; ns text; c public.inbox_canonical_messages%ROWTYPE; route uuid; origin_ep public.whatsapp_channel_memberships%ROWTYPE; changed integer:=0; n integer:=0; bcount integer;
BEGIN
 IF p_token IS NULL OR p_native IS NULL OR length(btrim(p_native)) NOT BETWEEN 1 AND 512 OR p_status NOT IN ('sent','delivered','read','failed') THEN RETURN 'unknown'; END IF;
 IF p_job IS NULL THEN
  SELECT * INTO r FROM public.whatsapp_webhook_event_receipts WHERE account_id=p_account AND connection_id=p_connection AND provider='openwa' AND provider_event_id=p_event AND processing_token=p_token AND processed_at IS NULL AND processing_started_at>=clock_timestamp()-interval '90 seconds' FOR UPDATE;
 ELSE
  SELECT wr.* INTO r FROM public.openwa_deferred_events q JOIN public.whatsapp_webhook_event_receipts wr ON wr.account_id=q.account_id AND wr.connection_id=q.connection_id AND wr.provider_event_id=q.provider_event_id AND wr.provider='openwa'
  JOIN public.whatsapp_connections wc ON wc.id=q.connection_id AND wc.account_id=q.account_id AND wc.provider='openwa'
   WHERE q.id=p_job AND q.account_id=p_account AND q.connection_id=p_connection AND q.event_kind='unmatched_status' AND q.state='leased' AND q.lease_token=p_token AND q.lease_until>clock_timestamp()
   AND q.expires_at>clock_timestamp() AND q.provider_message_id=p_native AND q.normalized_payload->>'status'=p_status AND q.session_id=p_session AND q.instance_id IS NOT DISTINCT FROM p_instance
   AND q.own_phone_identity IS NOT DISTINCT FROM wc.phone_identity AND wr.processed_at IS NOT NULL FOR UPDATE OF wr FOR SHARE OF q;
 END IF;
 IF NOT FOUND THEN RETURN 'unknown'; END IF;
 ep=public.inbox_active_observation_epoch(p_account,p_connection,p_session,p_instance,r.received_at);
 SELECT namespace_key INTO ns FROM public.inbox_native_namespace_proofs WHERE account_id=p_account AND membership_id=ep.id AND channel_id=ep.channel_id;
 IF ns IS NULL THEN RETURN 'unknown'; END IF;
 IF EXISTS(SELECT 1 FROM public.inbox_canonical_ack_observations WHERE receipt_id=r.id AND account_id=p_account AND native_message_id=p_native AND observed_status=p_status) THEN RETURN 'ignored'; END IF;
 IF EXISTS(SELECT 1 FROM public.inbox_canonical_ack_observations WHERE receipt_id=r.id) THEN RAISE EXCEPTION 'INBOX_ACK_RECEIPT_CONFLICT' USING ERRCODE='23514'; END IF;
 SELECT * INTO c FROM public.inbox_canonical_messages WHERE account_id=p_account AND provider='openwa' AND channel_id=ep.channel_id AND namespace_key=ns AND direction='outbound' AND native_message_id=p_native FOR UPDATE;
 route=p_connection; origin_ep=ep;
 IF c.id IS NOT NULL THEN
  IF c.source_message_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.inbox_message_memberships WHERE account_id=p_account AND message_id=c.source_message_id AND evidence_kind='verified_outbound_reservation' AND evidence_ref=c.id::text) THEN RETURN 'unknown'; END IF;
  SELECT m.* INTO origin_ep FROM public.whatsapp_channel_memberships m JOIN public.whatsapp_connections wc ON wc.id=m.connection_id AND wc.account_id=m.account_id AND wc.provider=m.provider
   WHERE m.id=c.origin_membership_id AND m.account_id=p_account AND m.channel_id=ep.channel_id AND m.valid_until IS NULL
   AND wc.archived_at IS NULL AND wc.session_id IS NOT DISTINCT FROM m.session_snapshot AND wc.instance_id IS NOT DISTINCT FROM m.instance_snapshot FOR SHARE OF m,wc;
  IF NOT FOUND THEN RETURN 'unknown'; END IF;
  route=c.origin_connection_id;
  IF EXISTS(SELECT 1 FROM public.messages m JOIN public.conversations cv ON cv.id=m.conversation_id AND cv.account_id=p_account
   WHERE m.connection_id=p_connection AND m.provider='openwa' AND m.provider_message_id=p_native AND m.id<>c.source_message_id AND m.sender_type IN ('agent','bot')) THEN RETURN 'unknown'; END IF;
  UPDATE public.messages SET status=p_status WHERE id=c.source_message_id AND conversation_id=c.conversation_id AND provider='openwa' AND connection_id=route AND provider_message_id=p_native AND sender_type IN ('agent','bot') AND public.inbox_status_forward(status,p_status);
  GET DIAGNOSTICS changed=ROW_COUNT;
 END IF;
 SELECT count(*) INTO bcount FROM public.broadcast_recipients br JOIN public.broadcasts b ON b.id=br.broadcast_id AND b.account_id=p_account
 WHERE br.connection_id=route AND br.provider='openwa' AND br.provider_message_id=p_native AND br.sent_at>=origin_ep.valid_from AND br.sent_at<=r.received_at;
 IF bcount>1 THEN RAISE EXCEPTION 'INBOX_ACK_AMBIGUOUS_BROADCAST' USING ERRCODE='23514'; END IF;
 IF c.id IS NULL AND bcount=0 THEN RETURN 'unknown'; END IF;
 IF bcount=1 THEN
  UPDATE public.broadcast_recipients br SET status=p_status,delivered_at=CASE WHEN p_status='delivered' THEN coalesce(br.delivered_at,r.received_at) ELSE br.delivered_at END,
  read_at=CASE WHEN p_status='read' THEN coalesce(br.read_at,r.received_at) ELSE br.read_at END
   FROM public.broadcasts b WHERE b.id=br.broadcast_id AND b.account_id=p_account AND br.connection_id=route AND br.provider='openwa' AND br.provider_message_id=p_native
    AND br.sent_at>=origin_ep.valid_from AND br.sent_at<=r.received_at AND public.inbox_status_forward(br.status,p_status);
  GET DIAGNOSTICS n=ROW_COUNT;
 END IF;
 INSERT INTO public.inbox_canonical_ack_observations(receipt_id,account_id,provider,connection_id,channel_id,membership_id,canonical_id,native_message_id,observed_status)
 VALUES(r.id,p_account,'openwa',p_connection,ep.channel_id,ep.id,c.id,p_native,p_status);
 RETURN CASE WHEN changed+n>0 THEN 'updated' ELSE 'ignored' END;
END $$;
REVOKE ALL ON FUNCTION public.inbox_apply_canonical_ack(uuid,uuid,text,uuid,text,text,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_apply_canonical_ack(uuid,uuid,text,uuid,text,text,text,text,uuid) TO service_role;
