-- Preserve causal source identity across deletion/correction; never fall back
-- to a different connection for an already canonical queued reply.
ALTER TABLE public.inbox_canonical_messages ADD COLUMN first_source_message_id uuid;
UPDATE public.inbox_canonical_messages SET first_source_message_id=source_message_id WHERE source_message_id IS NOT NULL;
CREATE UNIQUE INDEX inbox_canonical_first_source_uidx ON public.inbox_canonical_messages(first_source_message_id) WHERE first_source_message_id IS NOT NULL;
ALTER TABLE public.inbox_canonical_messages ADD CONSTRAINT inbox_canonical_first_source_consistency CHECK(source_message_id IS NULL OR first_source_message_id IS NOT DISTINCT FROM source_message_id);
CREATE FUNCTION wacrm_internal.inbox_freeze_first_source()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN NEW.first_source_message_id=NEW.source_message_id;
 ELSE
  IF OLD.first_source_message_id IS NOT NULL AND NEW.source_message_id IS NOT NULL AND (OLD.source_message_id IS NULL OR NEW.source_message_id<>OLD.first_source_message_id) THEN
   RAISE EXCEPTION 'INBOX_CANONICAL_SOURCE_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  NEW.first_source_message_id=coalesce(OLD.first_source_message_id,NEW.source_message_id);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_freeze_first_source() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER inbox_freeze_first_source BEFORE INSERT OR UPDATE OF source_message_id,first_source_message_id ON public.inbox_canonical_messages FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_freeze_first_source();
CREATE FUNCTION public.inbox_canonical_agent_run_scope(p_account uuid,p_conversation uuid,p_run uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE r public.ai_agent_runs%ROWTYPE; cm public.inbox_canonical_messages%ROWTYPE;
BEGIN
 SELECT * INTO r FROM public.ai_agent_runs WHERE id=p_run AND account_id=p_account AND conversation_id=p_conversation;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_CAUSAL_RUN_UNAVAILABLE' USING ERRCODE='23514'; END IF;
 IF r.run_mode<>'inbound' THEN RETURN NULL; END IF;
 SELECT * INTO cm FROM public.inbox_canonical_messages WHERE account_id=p_account AND first_source_message_id=r.inbound_message_id AND direction='inbound';
 IF NOT FOUND THEN
  IF EXISTS(SELECT 1 FROM public.inbox_message_memberships WHERE account_id=p_account AND message_id=r.inbound_message_id AND evidence_kind='verified_current_ingress') THEN
   RAISE EXCEPTION 'INBOX_CAUSAL_ROUTE_UNAVAILABLE' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
 END IF;
 IF cm.conversation_id<>p_conversation OR cm.source_message_id IS DISTINCT FROM r.inbound_message_id OR NOT public.inbox_validate_canonical_route(p_account,p_conversation,r.inbound_message_id,cm.origin_connection_id) THEN
 RAISE EXCEPTION 'INBOX_CAUSAL_ROUTE_UNAVAILABLE' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('messageId',r.inbound_message_id,'connectionId',cm.origin_connection_id);
END $$;
REVOKE ALL ON FUNCTION public.inbox_canonical_agent_run_scope(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_canonical_agent_run_scope(uuid,uuid,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.inbox_canonical_agent_run_route(p_account uuid,p_conversation uuid,p_run uuid)
RETURNS uuid LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT (public.inbox_canonical_agent_run_scope(p_account,p_conversation,p_run)->>'connectionId')::uuid
$$;
CREATE OR REPLACE FUNCTION public.inbox_canonical_receipt_outcome(p_account uuid,p_connection uuid,p_event text,p_token uuid,p_native text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE rid uuid; v record; ep public.whatsapp_channel_memberships%ROWTYPE;
BEGIN
 rid=public.inbox_authorized_receipt(p_account,p_connection,p_event,p_token,p_native);
 IF rid IS NULL THEN RETURN jsonb_build_object('state','review'); END IF;
 IF EXISTS(SELECT 1 FROM public.inbox_canonical_intake_review WHERE receipt_id=rid AND account_id=p_account AND resolved_at IS NULL)
 THEN RETURN jsonb_build_object('state','review'); END IF;
 SELECT c.source_message_id,c.conversation_id,c.origin_connection_id,c.native_message_id,e.state,o.membership_id,m.session_snapshot,m.instance_snapshot,r.received_at INTO v
 FROM public.inbox_message_connection_observations o JOIN public.inbox_canonical_messages c ON c.id=o.canonical_id AND c.account_id=o.account_id
 JOIN public.inbox_canonical_effects e ON e.canonical_id=c.id AND e.account_id=c.account_id
 JOIN public.inbox_message_memberships im ON im.message_id=c.source_message_id AND im.account_id=c.account_id AND im.evidence_kind='verified_current_ingress'
 JOIN public.whatsapp_channel_memberships m ON m.id=o.membership_id AND m.account_id=o.account_id AND m.connection_id=o.connection_id
 JOIN public.whatsapp_webhook_event_receipts r ON r.id=o.receipt_id AND r.account_id=o.account_id AND r.connection_id=o.connection_id
 WHERE o.connection_id=p_connection AND o.receipt_id=rid AND o.account_id=p_account AND o.native_message_id=p_native;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','review'); END IF;
 ep=public.inbox_active_observation_epoch(p_account,p_connection,v.session_snapshot,v.instance_snapshot,v.received_at);
 IF ep.id IS DISTINCT FROM v.membership_id OR NOT public.inbox_validate_canonical_route(p_account,v.conversation_id,v.source_message_id,v.origin_connection_id) THEN RETURN jsonb_build_object('state','review'); END IF;
 RETURN jsonb_build_object('state',CASE WHEN v.state='returned' THEN 'completed' WHEN v.state='pending' THEN 'pending' ELSE 'review' END,
  'messageId',CASE WHEN v.origin_connection_id=p_connection THEN v.source_message_id ELSE NULL END,
  'conversationId',CASE WHEN v.origin_connection_id=p_connection THEN v.conversation_id ELSE NULL END);
END $$;
