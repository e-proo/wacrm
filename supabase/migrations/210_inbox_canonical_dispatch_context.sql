-- SOF-89.03: exact receipt-bound dispatch context and fail-closed source lifecycle.
-- No live enablement; direct signed TEST ingress only, flag off by default.
ALTER TABLE public.inbox_canonical_effects ADD COLUMN dispatch_context jsonb;
ALTER TABLE public.inbox_canonical_effects ADD COLUMN payload_digest text;
GRANT UPDATE(dispatch_context,payload_digest) ON public.inbox_canonical_effects TO service_role;
ALTER TABLE public.inbox_canonical_intake_review DROP CONSTRAINT inbox_canonical_intake_review_reason_check;
ALTER TABLE public.inbox_canonical_intake_review ADD CONSTRAINT inbox_canonical_intake_review_reason_check CHECK(reason IN ('missing_verified_epoch','event_only_identity','namespace_unverified','peer_conflict','receipt_conflict','legacy_collision','outbound_echo_unproven','reaction_unproven','source_unconfirmed','payload_changed'));
-- One proven namespace per channel; unknown engine aliases stay unresolved.
CREATE FUNCTION public.inbox_guard_namespace_contract() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.whatsapp_channels WHERE account_id=NEW.account_id AND provider=NEW.provider AND id=NEW.channel_id FOR NO KEY UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.inbox_native_namespace_proofs WHERE account_id=NEW.account_id AND provider=NEW.provider AND channel_id=NEW.channel_id AND namespace_key<>NEW.namespace_key)
 THEN RAISE EXCEPTION 'INBOX_NAMESPACE_CONTRACT_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.inbox_guard_namespace_contract() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER inbox_guard_namespace_contract BEFORE INSERT ON public.inbox_native_namespace_proofs FOR EACH ROW EXECUTE FUNCTION public.inbox_guard_namespace_contract();

CREATE FUNCTION public.inbox_hold_signed_observation(p_account uuid,p_connection uuid,p_event text,p_token uuid,p_session text,p_instance text,p_reason text,p_payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE rid uuid;
BEGIN
 IF p_reason NOT IN ('outbound_echo_unproven','reaction_unproven','source_unconfirmed','payload_changed') THEN RAISE EXCEPTION 'INBOX_BAD_REVIEW_REASON' USING ERRCODE='22023'; END IF;
 SELECT r.id INTO rid FROM public.whatsapp_webhook_event_receipts r JOIN public.whatsapp_connections c ON c.id=r.connection_id AND c.account_id=r.account_id AND c.provider=r.provider
 WHERE r.account_id=p_account AND r.connection_id=p_connection AND r.provider='openwa' AND r.provider_event_id=p_event
 AND r.processing_token=p_token AND p_token IS NOT NULL AND r.processed_at IS NULL AND r.processing_started_at>=clock_timestamp()-interval '90 seconds'
 AND c.session_id=p_session AND c.instance_id IS NOT DISTINCT FROM p_instance AND c.archived_at IS NULL FOR UPDATE OF r;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_SIGNED_RECEIPT_REQUIRED' USING ERRCODE='42501'; END IF;
 INSERT INTO public.inbox_canonical_intake_review(receipt_id,account_id,connection_id,provider,reason,normalized_payload) VALUES(rid,p_account,p_connection,'openwa',p_reason,p_payload)
 ON CONFLICT(receipt_id) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.inbox_hold_signed_observation(uuid,uuid,text,uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_hold_signed_observation(uuid,uuid,text,uuid,text,text,text,jsonb) TO service_role;

CREATE FUNCTION public.inbox_commit_canonical_inbound_context(
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
  IF d->>'reason'='source_unconfirmed' THEN PERFORM public.inbox_hold_signed_observation(p_account,p_connection,p_event,p_token,p_session,p_instance,'source_unconfirmed',p_payload); END IF;
  RETURN d;
 END IF;
 SELECT * INTO STRICT e FROM public.inbox_canonical_effects WHERE account_id=p_account AND canonical_id=(d->>'canonicalId')::uuid FOR UPDATE;
 digest_value=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
 IF d->>'state'='inserted' THEN
  context_value=jsonb_build_object('firstInbound',coalesce((d->>'firstInbound')::boolean,false),'contactCreated',coalesce(p_contact_created,false),
    'conversationCreated',coalesce(p_conversation_created,false),'replyToMessageId',d->'replyToMessageId');
  UPDATE public.inbox_canonical_effects SET dispatch_context=context_value,payload_digest=digest_value WHERE account_id=p_account AND canonical_id=e.canonical_id;
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

-- Current origin epoch and exact lease must still be valid at dispatch.
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
 UPDATE public.inbox_canonical_effects SET state='claimed',claim_token=gen_random_uuid(),claimed_at=clock_timestamp()
 WHERE account_id=p_account AND canonical_id=p_canonical AND state='pending' RETURNING claim_token INTO tok;
 RETURN tok;
END $$;
REVOKE ALL ON FUNCTION public.inbox_claim_canonical_effect(uuid,uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated;

-- Canonical identity survives source deletion/identity correction as a tombstone;
-- do not recreate or dispatch the message on signed replay. Reparent retains
-- exact original route and canonical ID.
CREATE FUNCTION wacrm_internal.inbox_canonical_source_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.inbox_canonical_messages%ROWTYPE;
BEGIN
 SELECT * INTO c FROM public.inbox_canonical_messages WHERE source_message_id=OLD.id FOR UPDATE;
 IF NOT FOUND THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
 IF TG_OP='DELETE' THEN
  UPDATE public.inbox_canonical_messages SET source_message_id=NULL WHERE id=c.id AND account_id=c.account_id;
  UPDATE public.inbox_canonical_effects SET state='review' WHERE canonical_id=c.id AND account_id=c.account_id AND state IN ('pending','claimed');
  RETURN OLD;
 END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id OR NEW.message_id IS DISTINCT FROM OLD.message_id OR NEW.sender_type IS DISTINCT FROM OLD.sender_type OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.provider_chat_id IS DISTINCT FROM OLD.provider_chat_id THEN
  UPDATE public.inbox_canonical_messages SET source_message_id=NULL WHERE id=c.id AND account_id=c.account_id;
  UPDATE public.inbox_canonical_effects SET state='review' WHERE canonical_id=c.id AND account_id=c.account_id AND state IN ('pending','claimed');
 ELSIF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
  IF NOT EXISTS(SELECT 1 FROM public.conversations WHERE id=NEW.conversation_id AND account_id=c.account_id) THEN RAISE EXCEPTION 'INBOX_CROSS_ACCOUNT_SOURCE_MOVE' USING ERRCODE='23514'; END IF;
  UPDATE public.inbox_canonical_messages SET conversation_id=NEW.conversation_id WHERE id=c.id AND account_id=c.account_id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_canonical_source_lifecycle() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER inbox_canonical_source_update AFTER UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_canonical_source_lifecycle();
CREATE TRIGGER inbox_canonical_source_delete BEFORE DELETE ON public.messages FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_canonical_source_lifecycle();

CREATE FUNCTION wacrm_internal.inbox_effect_no_reclaim()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF (OLD.state='claimed' AND NEW.state NOT IN ('claimed','returned','review')) OR
    (OLD.state IN ('returned','review') AND NEW.state<>OLD.state) OR
    (OLD.claim_token IS NOT NULL AND NEW.claim_token IS DISTINCT FROM OLD.claim_token) OR
    (OLD.payload_digest IS NOT NULL AND NEW.payload_digest IS DISTINCT FROM OLD.payload_digest) OR
    (OLD.dispatch_context IS NOT NULL AND NEW.dispatch_context IS DISTINCT FROM OLD.dispatch_context)
 THEN RAISE EXCEPTION 'INBOX_EFFECT_IMMUTABLE_CLAIM' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_effect_no_reclaim() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER inbox_effect_no_reclaim BEFORE UPDATE ON public.inbox_canonical_effects FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_effect_no_reclaim();
