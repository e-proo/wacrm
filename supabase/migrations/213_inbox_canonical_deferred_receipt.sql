-- SOF-89.07: reuse the original receipt in durable deferred identity processing.
-- An expired/foreign lease, missing native proof or changed epoch never authorizes intake.
CREATE FUNCTION public.inbox_authorized_receipt(p_account uuid,p_connection uuid,p_event text,p_token uuid,p_native text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE rid uuid;
BEGIN
 IF p_token IS NULL THEN RETURN NULL; END IF;
 SELECT r.id INTO rid FROM public.whatsapp_webhook_event_receipts r WHERE r.account_id=p_account AND r.connection_id=p_connection AND r.provider='openwa' AND r.provider_event_id=p_event
 AND r.processing_token=p_token AND r.processed_at IS NULL AND r.processing_started_at>=clock_timestamp()-interval '90 seconds' FOR UPDATE;
 IF FOUND THEN RETURN rid; END IF;
 SELECT r.id INTO rid FROM public.whatsapp_webhook_event_receipts r
 JOIN public.openwa_deferred_events q ON q.account_id=r.account_id AND q.connection_id=r.connection_id AND q.provider_event_id=r.provider_event_id
 JOIN public.whatsapp_connections c ON c.id=q.connection_id AND c.account_id=q.account_id AND c.provider='openwa'
 JOIN public.whatsapp_channel_memberships ep ON ep.account_id=c.account_id AND ep.connection_id=c.id AND ep.provider=c.provider AND ep.valid_until IS NULL
 WHERE r.account_id=p_account AND r.connection_id=p_connection AND r.provider='openwa' AND r.provider_event_id=p_event AND r.processed_at IS NOT NULL
 AND q.event_kind='unresolved_identity' AND q.state='leased' AND q.lease_token=p_token AND q.lease_until>clock_timestamp()
 AND q.expires_at>clock_timestamp() AND (p_native IS NULL OR q.provider_message_id=p_native)
 AND q.normalized_payload->'message'->>'providerMessageIdentityKind'='native'
 AND q.normalized_payload->'message'->>'providerMessageId'=q.provider_message_id
 AND q.normalized_payload->'message'->>'providerEventId'=r.provider_event_id
 AND q.normalized_payload->'message'->'providerMetadata'->>'sessionId'=q.session_id
 AND (q.normalized_payload->'message'->'providerMetadata'->>'instanceId') IS NOT DISTINCT FROM q.instance_id
 AND q.session_id=c.session_id AND q.instance_id IS NOT DISTINCT FROM c.instance_id AND q.own_phone_identity IS NOT DISTINCT FROM c.phone_identity
 AND c.status IN ('ready','connected') AND c.archived_at IS NULL AND ep.session_snapshot=c.session_id
 AND ep.instance_snapshot IS NOT DISTINCT FROM c.instance_id AND r.received_at>=ep.valid_from
 FOR UPDATE OF r FOR SHARE OF q,c,ep;
 RETURN rid;
END $$;
REVOKE ALL ON FUNCTION public.inbox_authorized_receipt(uuid,uuid,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_authorized_receipt(uuid,uuid,text,uuid,text) TO service_role;
-- Preserve one observation per signed delivery, even if multiple receipts
-- represent a repeat from the same route. The canonical identity remains unique.
DO $$ DECLARE n text; BEGIN
 SELECT conname INTO STRICT n FROM pg_constraint WHERE conrelid='public.inbox_message_connection_observations'::regclass AND contype='u'
 AND pg_get_constraintdef(oid)='UNIQUE (canonical_id, connection_id, native_message_id, direction)';
 EXECUTE format('ALTER TABLE public.inbox_message_connection_observations DROP CONSTRAINT %I',n);
END $$;
CREATE INDEX inbox_observation_native_route_idx ON public.inbox_message_connection_observations(account_id,connection_id,native_message_id,direction);

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
REVOKE ALL ON FUNCTION public.inbox_record_canonical_observation(uuid,uuid,text,uuid,uuid,text,text,text,boolean,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_record_canonical_observation(uuid,uuid,text,uuid,uuid,text,text,text,boolean,text,jsonb) TO service_role;


CREATE OR REPLACE FUNCTION public.inbox_commit_canonical_inbound_context(
 p_account uuid,p_connection uuid,p_event text,p_token uuid,p_conversation uuid,p_session text,p_instance text,
 p_native_id text,p_native_proven boolean,p_content_type text,p_content_text text,p_media_type text,p_chat_id text,
 p_timestamp timestamptz,p_reply_native_id text,p_payload jsonb,p_contact_created boolean,p_conversation_created boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE d jsonb; e public.inbox_canonical_effects%ROWTYPE; digest_value text; context_value jsonb; original_route boolean;
BEGIN
 IF public.inbox_authorized_receipt(p_account,p_connection,p_event,p_token,p_native_id) IS NULL
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
 WHERE c.id=e.canonical_id AND c.account_id=p_account AND c.origin_connection_id=p_connection AND o.connection_id=p_connection AND r.id=public.inbox_authorized_receipt(p_account,p_connection,p_event,p_token,p_native_id))
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



CREATE OR REPLACE FUNCTION public.inbox_hold_signed_observation(p_account uuid,p_connection uuid,p_event text,p_token uuid,p_session text,p_instance text,p_reason text,p_payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE rid uuid;
BEGIN
 IF p_reason NOT IN ('outbound_echo_unproven','reaction_unproven','source_unconfirmed','payload_changed') THEN RAISE EXCEPTION 'INBOX_BAD_REVIEW_REASON' USING ERRCODE='22023'; END IF;
 SELECT r.id INTO rid FROM public.whatsapp_webhook_event_receipts r JOIN public.whatsapp_connections c ON c.id=r.connection_id AND c.account_id=r.account_id AND c.provider=r.provider
 WHERE r.account_id=p_account AND r.connection_id=p_connection AND r.provider='openwa' AND r.provider_event_id=p_event
 AND r.id=public.inbox_authorized_receipt(p_account,p_connection,p_event,p_token,NULL)
 AND c.session_id=p_session AND c.instance_id IS NOT DISTINCT FROM p_instance AND c.archived_at IS NULL FOR UPDATE OF r;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_SIGNED_RECEIPT_REQUIRED' USING ERRCODE='42501'; END IF;
 INSERT INTO public.inbox_canonical_intake_review(receipt_id,account_id,connection_id,provider,reason,normalized_payload) VALUES(rid,p_account,p_connection,'openwa',p_reason,p_payload)
 ON CONFLICT(receipt_id) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.inbox_hold_signed_observation(uuid,uuid,text,uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_hold_signed_observation(uuid,uuid,text,uuid,text,text,text,jsonb) TO service_role;


CREATE OR REPLACE FUNCTION public.inbox_commit_canonical_inbound(
 p_account uuid,p_connection uuid,p_event text,p_token uuid,p_conversation uuid,p_session text,p_instance text,
 p_native_id text,p_native_proven boolean,p_content_type text,p_content_text text,p_media_type text,
 p_chat_id text,p_timestamp timestamptz,p_reply_native_id text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE decision jsonb; canon public.inbox_canonical_messages%ROWTYPE; effect public.inbox_canonical_effects%ROWTYPE; t public.inbox_threads%ROWTYPE; source_id uuid; reply_id uuid; receipt uuid; seq bigint; first_inbound boolean;
BEGIN
 IF p_timestamp IS NULL OR p_timestamp>clock_timestamp()+interval '5 minutes'
 OR p_content_type NOT IN ('text','image','video','document','audio','location','template','interactive')
 OR (p_chat_id IS NOT NULL AND p_chat_id !~ '^[0-9]{5,20}@(c[.]us|lid)$')
 THEN RAISE EXCEPTION 'INBOX_BAD_CANONICAL_INPUT' USING ERRCODE='22023'; END IF;
 decision=public.inbox_record_canonical_observation(p_account,p_connection,p_event,p_token,p_conversation,p_session,p_instance,p_native_id,p_native_proven,'inbound',p_payload);
 IF decision->>'state'='review' THEN RETURN decision; END IF;
 SELECT * INTO STRICT canon FROM public.inbox_canonical_messages WHERE account_id=p_account AND id=(decision->>'canonicalId')::uuid FOR UPDATE;
 SELECT * INTO STRICT effect FROM public.inbox_canonical_effects WHERE account_id=p_account AND canonical_id=canon.id FOR UPDATE;
 IF canon.source_message_id IS NOT NULL THEN
  -- Duplicate observes only. Never grant task/agent dispatch on secondary,
  -- including if the original handler crashed after a possible dispatch.
  RETURN jsonb_build_object('state','duplicate','canonicalId',canon.id,'messageId',canon.source_message_id,'effectState',effect.state);
 END IF;
 IF effect.state<>'awaiting_source' OR canon.origin_connection_id<>p_connection THEN
  RETURN jsonb_build_object('state','review','reason','source_unconfirmed','canonicalId',canon.id);
 END IF;
 PERFORM 1 FROM public.conversations WHERE id=p_conversation AND account_id=p_account FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_CONVERSATION_SCOPE' USING ERRCODE='23514'; END IF;
 first_inbound=NOT EXISTS(SELECT 1 FROM public.messages WHERE conversation_id=p_conversation AND sender_type='customer');
 -- Reply references are never transplanted across a session. Only an exact
 -- native routing match is eligible; a missing match stores no reply ID.
 IF p_reply_native_id IS NOT NULL THEN
  SELECT id INTO reply_id FROM public.messages WHERE conversation_id=p_conversation AND provider='openwa' AND connection_id=p_connection AND provider_message_id=p_reply_native_id;
 END IF;
 INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,media_type,message_id,provider,connection_id,provider_message_id,provider_chat_id,status,created_at,reply_to_message_id)
 VALUES(p_conversation,'customer',p_content_type,p_content_text,p_media_type,p_native_id,'openwa',p_connection,p_native_id,p_chat_id,'delivered',p_timestamp,reply_id)
 ON CONFLICT DO NOTHING RETURNING id INTO source_id;
 IF source_id IS NULL AND EXISTS(
   SELECT 1 FROM public.messages m WHERE m.conversation_id=p_conversation AND m.message_id=p_native_id
   AND m.provider IS NOT NULL AND m.connection_id IS NOT NULL
   AND (m.provider<> 'openwa' OR m.connection_id<>p_connection)
 ) AND NOT EXISTS(
   SELECT 1 FROM public.messages m WHERE m.provider='openwa' AND m.connection_id=p_connection
   AND (m.provider_message_id=p_native_id OR (m.provider_message_id IS NULL AND m.message_id=p_native_id))
 ) THEN
  -- Legacy compatibility: NULL is already a valid legacy message_id.
  -- Preserve the exact provider-native identity in provider_message_id.
  -- Only a proven different-route collision may take this path; neither
  -- original row nor legacy unique index is rewritten.
  INSERT INTO public.messages(conversation_id,sender_type,content_type,content_text,media_type,message_id,provider,connection_id,provider_message_id,provider_chat_id,status,created_at,reply_to_message_id)
  VALUES(p_conversation,'customer',p_content_type,p_content_text,p_media_type,NULL,'openwa',p_connection,p_native_id,p_chat_id,'delivered',p_timestamp,reply_id)
  ON CONFLICT DO NOTHING RETURNING id INTO source_id;
 END IF;
 IF source_id IS NULL THEN
  -- Unproven/same-route legacy collision: retain signed payload in review.
  -- Never adopt a legacy row without authenticated source provenance.
  SELECT id INTO STRICT receipt FROM public.whatsapp_webhook_event_receipts WHERE account_id=p_account AND connection_id=p_connection AND provider='openwa' AND id=public.inbox_authorized_receipt(p_account,p_connection,p_event,p_token,p_native_id);
  INSERT INTO public.inbox_canonical_intake_review(receipt_id,account_id,connection_id,provider,reason,normalized_payload)
  VALUES(receipt,p_account,p_connection,'openwa','legacy_collision',p_payload) ON CONFLICT(receipt_id) DO NOTHING;
  UPDATE public.inbox_canonical_effects SET state='review' WHERE canonical_id=canon.id AND account_id=p_account;
  RETURN jsonb_build_object('state','review','reason','legacy_collision','canonicalId',canon.id);
 END IF;
 UPDATE public.inbox_canonical_messages SET source_message_id=source_id WHERE id=canon.id AND account_id=p_account;
 INSERT INTO public.inbox_threads(account_id,conversation_id,channel_id,provider) VALUES(p_account,p_conversation,canon.channel_id,'openwa')
 ON CONFLICT(account_id,conversation_id,channel_id) DO NOTHING;
 SELECT * INTO STRICT t FROM public.inbox_threads WHERE account_id=p_account AND conversation_id=p_conversation AND channel_id=canon.channel_id FOR UPDATE;
 seq=t.ingest_highwater+1;
 UPDATE public.inbox_threads SET ingest_highwater=seq WHERE account_id=p_account AND id=t.id;
 INSERT INTO public.inbox_message_memberships(message_id,account_id,conversation_id,channel_id,thread_id,provider,connection_id,membership_id,evidence_kind,evidence_ref,ingest_sequence)
 VALUES(source_id,p_account,p_conversation,canon.channel_id,t.id,'openwa',p_connection,canon.origin_membership_id,'verified_current_ingress',canon.id::text,seq);
 -- Existing CRM count remains compatible; legacy-unallocated bucket must not
 -- also count the new trusted channel message. No retrospective window.
 UPDATE public.conversations SET unread_count=coalesce(unread_count,0)+1,
 last_message_text=CASE WHEN last_message_at IS NULL OR p_timestamp>=last_message_at THEN coalesce(p_content_text,'['||p_content_type||']') ELSE last_message_text END,
 last_message_at=greatest(last_message_at,p_timestamp),updated_at=clock_timestamp()
 WHERE id=p_conversation AND account_id=p_account;
 UPDATE public.inbox_legacy_unread l SET unread_count=greatest(0,l.unread_count-(SELECT coalesce(sum(unread_count_known),0) FROM public.inbox_threads WHERE account_id=p_account AND conversation_id=p_conversation))
 WHERE l.account_id=p_account AND l.conversation_id=p_conversation;
 UPDATE public.inbox_canonical_effects SET state='pending' WHERE canonical_id=canon.id AND account_id=p_account;
 RETURN jsonb_build_object('state','inserted','canonicalId',canon.id,'messageId',source_id,'replyToMessageId',reply_id,'firstInbound',first_inbound);
END $$;
REVOKE ALL ON FUNCTION public.inbox_commit_canonical_inbound(uuid,uuid,text,uuid,uuid,text,text,text,boolean,text,text,text,text,timestamptz,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_commit_canonical_inbound(uuid,uuid,text,uuid,uuid,text,text,text,boolean,text,text,text,text,timestamptz,text,jsonb) TO service_role;



CREATE OR REPLACE FUNCTION public.inbox_claim_canonical_effect(p_account uuid,p_canonical uuid,p_connection uuid,p_event text,p_receipt_token uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE tok uuid; c public.inbox_canonical_messages%ROWTYPE;
BEGIN
 SELECT * INTO c FROM public.inbox_canonical_messages WHERE account_id=p_account AND id=p_canonical AND origin_connection_id=p_connection AND direction='inbound' FOR UPDATE;
 IF NOT FOUND OR c.source_message_id IS NULL THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.whatsapp_webhook_event_receipts r JOIN public.inbox_message_connection_observations o ON o.receipt_id=r.id AND o.account_id=r.account_id
 JOIN public.whatsapp_channel_memberships ep ON ep.id=o.membership_id AND ep.account_id=o.account_id AND ep.channel_id=o.channel_id AND ep.connection_id=o.connection_id
 JOIN public.whatsapp_connections wc ON wc.id=o.connection_id AND wc.account_id=o.account_id AND wc.provider=o.provider
 WHERE r.account_id=p_account AND r.connection_id=p_connection AND r.provider='openwa' AND r.id=public.inbox_authorized_receipt(p_account,p_connection,p_event,p_receipt_token,c.native_message_id) AND o.canonical_id=p_canonical
 AND ep.id=c.origin_membership_id AND ep.valid_until IS NULL AND wc.archived_at IS NULL AND wc.status IN ('ready','connected')
 AND wc.session_id IS NOT DISTINCT FROM ep.session_snapshot AND wc.instance_id IS NOT DISTINCT FROM ep.instance_snapshot) THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.inbox_message_memberships WHERE account_id=p_account AND message_id=c.source_message_id AND evidence_kind='verified_current_ingress' AND evidence_ref=c.id::text) THEN RETURN NULL; END IF;
 -- Current legacy Task correlation selects candidates by CRM parent rather
 -- than WhatsApp route. Until the dedicated exact-causal routing policy is
 -- activated, conservatively hold instead of mutating a foreign reservation.
 IF EXISTS(
   SELECT 1 FROM public.ai_agent_task_targets target
   JOIN public.ai_agent_tasks task ON task.id=target.task_id AND task.account_id=target.account_id
   LEFT JOIN public.messages outbound ON outbound.id=target.last_outbound_message_id AND outbound.conversation_id=c.conversation_id
   WHERE target.account_id=p_account AND target.conversation_id=c.conversation_id AND task.status='running'
   AND target.status IN ('queued','preparing','contacted','awaiting_reply','replied','in_progress')
   AND target.last_outbound_message_id IS NOT NULL
   AND (outbound.id IS NULL OR outbound.provider IS DISTINCT FROM c.provider OR outbound.connection_id IS DISTINCT FROM c.origin_connection_id)
 ) THEN
  UPDATE public.inbox_canonical_effects SET state='review' WHERE account_id=p_account AND canonical_id=p_canonical AND state='pending';
  RETURN NULL;
 END IF;
 UPDATE public.inbox_canonical_effects SET state='claimed',claim_token=gen_random_uuid(),claimed_at=clock_timestamp()
 WHERE account_id=p_account AND canonical_id=p_canonical AND state='pending' RETURNING claim_token INTO tok;
 RETURN tok;
END $$;
REVOKE ALL ON FUNCTION public.inbox_claim_canonical_effect(uuid,uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated;



-- Worker finishes only from durable proof; a held or possibly dispatched
-- event is review, not success. A retry cannot grant another business claim.
CREATE FUNCTION public.inbox_canonical_receipt_outcome(p_account uuid,p_connection uuid,p_event text,p_token uuid,p_native text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE rid uuid; v record;
BEGIN
 rid=public.inbox_authorized_receipt(p_account,p_connection,p_event,p_token,p_native);
 IF rid IS NULL THEN RETURN jsonb_build_object('state','review'); END IF;
 IF EXISTS(SELECT 1 FROM public.inbox_canonical_intake_review WHERE receipt_id=rid AND account_id=p_account AND resolved_at IS NULL)
 THEN RETURN jsonb_build_object('state','review'); END IF;
 SELECT c.source_message_id,c.conversation_id,c.origin_connection_id,c.native_message_id,e.state INTO v
 FROM public.inbox_message_connection_observations o JOIN public.inbox_canonical_messages c ON c.id=o.canonical_id AND c.account_id=o.account_id
 JOIN public.inbox_canonical_effects e ON e.canonical_id=c.id AND e.account_id=c.account_id
 JOIN public.inbox_message_memberships im ON im.message_id=c.source_message_id AND im.account_id=c.account_id AND im.evidence_kind='verified_current_ingress'
 WHERE o.receipt_id=rid AND o.account_id=p_account AND o.native_message_id=p_native;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','review'); END IF;
 RETURN jsonb_build_object('state',CASE WHEN v.state='returned' THEN 'completed' WHEN v.state='pending' THEN 'pending' ELSE 'review' END,
  'messageId',CASE WHEN v.origin_connection_id=p_connection THEN v.source_message_id ELSE NULL END,
  'conversationId',CASE WHEN v.origin_connection_id=p_connection THEN v.conversation_id ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION public.inbox_canonical_receipt_outcome(uuid,uuid,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_canonical_receipt_outcome(uuid,uuid,text,uuid,text) TO service_role;
