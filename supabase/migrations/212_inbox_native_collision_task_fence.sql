-- SOF-89.05: isolate exact native source identities across channels without
-- rewriting historical legacy IDs/index, and fail closed for mismatched
-- existing task bindings. All new runtime remains TEST-only gated.
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
  SELECT id INTO STRICT receipt FROM public.whatsapp_webhook_event_receipts WHERE account_id=p_account AND connection_id=p_connection AND provider='openwa' AND provider_event_id=p_event AND processing_token=p_token;
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
 WHERE r.account_id=p_account AND r.connection_id=p_connection AND r.provider='openwa' AND r.provider_event_id=p_event AND r.processing_token=p_receipt_token AND p_receipt_token IS NOT NULL
 AND r.processed_at IS NULL AND r.processing_started_at>=clock_timestamp()-interval '90 seconds' AND o.canonical_id=p_canonical
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


