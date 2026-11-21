-- SOF-89.04: fixed primary ingress origin, signed receipt scope, bounded race safety.
-- Secondary observations cannot silently become the task/send origin. Shared
-- namespace does not authorize fallback or a new sender.
ALTER TABLE public.inbox_canonical_intake_review DROP CONSTRAINT inbox_canonical_intake_review_reason_check;
ALTER TABLE public.inbox_canonical_intake_review ADD CONSTRAINT inbox_canonical_intake_review_reason_check CHECK(reason IN ('missing_verified_epoch','event_only_identity','namespace_unverified','peer_conflict','receipt_conflict','legacy_collision','outbound_echo_unproven','reaction_unproven','source_unconfirmed','payload_changed','primary_unavailable'));
ALTER TABLE public.inbox_canonical_intake_review ADD COLUMN resolved_at timestamptz;
GRANT UPDATE(resolved_at) ON public.inbox_canonical_intake_review TO service_role;
ALTER TABLE public.inbox_canonical_effects ADD COLUMN observed_contact_created boolean NOT NULL DEFAULT false;
ALTER TABLE public.inbox_canonical_effects ADD COLUMN observed_conversation_created boolean NOT NULL DEFAULT false;
GRANT UPDATE(observed_contact_created,observed_conversation_created) ON public.inbox_canonical_effects TO service_role;
CREATE UNIQUE INDEX inbox_receipt_account_connection_provider_id_uidx ON public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,id);
ALTER TABLE public.inbox_message_connection_observations ADD CONSTRAINT inbox_observation_receipt_scope FOREIGN KEY(account_id,connection_id,provider,receipt_id) REFERENCES public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,id);
ALTER TABLE public.inbox_canonical_intake_review ADD CONSTRAINT inbox_intake_review_receipt_scope FOREIGN KEY(account_id,connection_id,provider,receipt_id) REFERENCES public.whatsapp_webhook_event_receipts(account_id,connection_id,provider,id);
ALTER TABLE public.inbox_canonical_messages ADD CONSTRAINT inbox_canonical_source_parent FOREIGN KEY(conversation_id,source_message_id) REFERENCES public.messages(conversation_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION public.inbox_guard_canonical_source() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.source_message_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id
  WHERE m.id=NEW.source_message_id AND m.conversation_id=NEW.conversation_id AND c.account_id=NEW.account_id
  AND m.provider=NEW.provider AND m.connection_id=NEW.origin_connection_id AND m.provider_message_id=NEW.native_message_id
  AND (NEW.direction='outbound' AND m.sender_type IN ('agent','bot') OR NEW.direction='inbound' AND m.sender_type='customer'))
 THEN RAISE EXCEPTION 'INBOX_CANONICAL_SOURCE_SCOPE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.inbox_guard_canonical_source() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER inbox_guard_canonical_source BEFORE INSERT OR UPDATE OF source_message_id,conversation_id ON public.inbox_canonical_messages FOR EACH ROW EXECUTE FUNCTION public.inbox_guard_canonical_source();

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
 AND provider_event_id=p_event AND processing_token=p_token AND processed_at IS NULL AND processing_started_at>=clock_timestamp()-interval '90 seconds' FOR UPDATE;
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
  IF NOT FOUND THEN reason='namespace_unverified'; END IF;
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
   ON CONFLICT(canonical_id,connection_id,native_message_id,direction) DO NOTHING;
   INSERT INTO public.inbox_canonical_effects(canonical_id,account_id,provider,channel_id)
   VALUES(canon.id,p_account,'openwa',ep.channel_id) ON CONFLICT(canonical_id) DO NOTHING;
   RETURN jsonb_build_object('state',CASE WHEN new_id IS NULL THEN 'duplicate' ELSE 'reserved' END,'canonicalId',canon.id);
  END IF;
 END IF;
 INSERT INTO public.inbox_canonical_intake_review(receipt_id,account_id,connection_id,provider,reason,normalized_payload)
 VALUES(r.id,p_account,p_connection,'openwa',reason,p_payload);
 RETURN jsonb_build_object('state','review','reason',reason);
END $$;
REVOKE ALL ON FUNCTION public.inbox_record_canonical_observation(uuid,uuid,text,uuid,uuid,text,text,text,boolean,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_record_canonical_observation(uuid,uuid,text,uuid,uuid,text,text,text,boolean,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.inbox_commit_canonical_inbound_context(
 p_account uuid,p_connection uuid,p_event text,p_token uuid,p_conversation uuid,p_session text,p_instance text,
 p_native_id text,p_native_proven boolean,p_content_type text,p_content_text text,p_media_type text,p_chat_id text,
 p_timestamp timestamptz,p_reply_native_id text,p_payload jsonb,p_contact_created boolean,p_conversation_created boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE d jsonb; e public.inbox_canonical_effects%ROWTYPE; digest_value text; context_value jsonb; original_route boolean;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts r WHERE r.account_id=p_account AND r.connection_id=p_connection AND r.provider='openwa' AND r.provider_event_id=p_event AND r.processing_token=p_token AND p_token IS NOT NULL AND r.processed_at IS NULL AND r.processing_started_at>=clock_timestamp()-interval '90 seconds')
 THEN RAISE EXCEPTION 'INBOX_SIGNED_RECEIPT_REQUIRED' USING ERRCODE='42501'; END IF;
 d=public.inbox_commit_canonical_inbound(p_account,p_connection,p_event,p_token,p_conversation,p_session,p_instance,p_native_id,p_native_proven,p_content_type,p_content_text,p_media_type,p_chat_id,p_timestamp,p_reply_native_id,p_payload);
 IF d->>'state'='review' THEN
  IF d->>'reason'='source_unconfirmed' THEN
   PERFORM public.inbox_hold_signed_observation(p_account,p_connection,p_event,p_token,p_session,p_instance,'source_unconfirmed',p_payload);
   IF d->>'canonicalId' IS NOT NULL THEN
    UPDATE public.inbox_canonical_effects SET observed_contact_created=observed_contact_created OR coalesce(p_contact_created,false),
     observed_conversation_created=observed_conversation_created OR coalesce(p_conversation_created,false)
     WHERE account_id=p_account AND canonical_id=(d->>'canonicalId')::uuid AND state='awaiting_source';
   END IF;
  END IF;
  RETURN d;
 END IF;
 SELECT * INTO STRICT e FROM public.inbox_canonical_effects WHERE account_id=p_account AND canonical_id=(d->>'canonicalId')::uuid FOR UPDATE;
 digest_value=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
 IF d->>'state'='inserted' THEN
  context_value=jsonb_build_object('firstInbound',coalesce((d->>'firstInbound')::boolean,false),'contactCreated',coalesce(p_contact_created,false) OR e.observed_contact_created,
    'conversationCreated',coalesce(p_conversation_created,false) OR e.observed_conversation_created,'replyToMessageId',d->'replyToMessageId');
  UPDATE public.inbox_canonical_effects SET dispatch_context=context_value,payload_digest=digest_value WHERE account_id=p_account AND canonical_id=e.canonical_id;
  UPDATE public.inbox_canonical_intake_review q SET resolved_at=clock_timestamp()
    FROM public.inbox_message_connection_observations o WHERE o.account_id=p_account AND o.canonical_id=e.canonical_id AND o.receipt_id=q.receipt_id
    AND q.account_id=p_account AND q.reason='source_unconfirmed' AND q.resolved_at IS NULL;
  RETURN d||jsonb_build_object('dispatchContext',context_value,'canClaim',true);
 END IF;
 SELECT EXISTS(SELECT 1 FROM public.inbox_canonical_messages c JOIN public.inbox_message_connection_observations o ON o.canonical_id=c.id AND o.account_id=c.account_id JOIN public.whatsapp_webhook_event_receipts r ON r.id=o.receipt_id AND r.account_id=o.account_id
 WHERE c.id=e.canonical_id AND c.account_id=p_account AND c.origin_connection_id=p_connection AND o.connection_id=p_connection AND r.provider_event_id=p_event AND r.processing_token=p_token)
 INTO original_route;
 IF e.state='pending' AND original_route THEN
  IF e.payload_digest IS DISTINCT FROM digest_value OR e.dispatch_context IS NULL THEN
   UPDATE public.inbox_canonical_effects SET state='review' WHERE account_id=p_account AND canonical_id=e.canonical_id;
   PERFORM public.inbox_hold_signed_observation(p_account,p_connection,p_event,p_token,p_session,p_instance,'payload_changed',p_payload);
   RETURN jsonb_build_object('state','review','reason','payload_changed');
  END IF;
  RETURN d||jsonb_build_object('dispatchContext',e.dispatch_context,'canClaim',true);
 END IF;
 RETURN d||jsonb_build_object('canClaim',false);
END $$;
REVOKE ALL ON FUNCTION public.inbox_commit_canonical_inbound_context(uuid,uuid,text,uuid,uuid,text,text,text,boolean,text,text,text,text,timestamptz,text,jsonb,boolean,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_commit_canonical_inbound_context(uuid,uuid,text,uuid,uuid,text,text,text,boolean,text,text,text,text,timestamptz,text,jsonb,boolean,boolean) TO service_role;


