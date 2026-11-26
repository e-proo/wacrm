-- FIX-03 final conflict fence: exact identity does not settle a changed
-- payload, peer/receipt conflict or unrelated hold. Only source_unconfirmed
-- with the recorded digest (when available) may confirm an existing source.
-- No data changes; the original hold remains reviewable as unverified.
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
