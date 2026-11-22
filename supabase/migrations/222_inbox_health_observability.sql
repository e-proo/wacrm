-- INBOX-5 SOF-80: diagnostic-only tenant/actor-scoped rollup.
-- No message content, phone, native identity, credentials, or expanded grants.
-- Existing source/RLS unchanged; TEST-only admin HTTP endpoint controls exposure.
CREATE INDEX inbox_health_action_state_idx ON public.inbox_action_intents(account_id,state,created_at);
CREATE INDEX inbox_health_effect_state_idx ON public.inbox_canonical_effects(account_id,state,claimed_at);
CREATE INDEX inbox_health_membership_recent_idx ON public.inbox_message_memberships(account_id,recorded_at,thread_id);

CREATE FUNCTION public.inbox_health_snapshot(p_account uuid,p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE
 t bigint; active bigint; uncertain bigint; old_pending bigint; claimed_old bigint;
 review bigint; awaiting bigint; effects_pending bigint; mismatch bigint; projected bigint;
BEGIN
 IF p_account IS NULL OR p_actor IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.profiles
  WHERE account_id=p_account AND user_id=p_actor AND account_role IN ('owner','admin')
 ) THEN
  RAISE EXCEPTION 'INBOX_HEALTH_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 SELECT count(*) INTO t FROM public.inbox_threads WHERE account_id=p_account;
 SELECT count(*) INTO active FROM public.whatsapp_channel_memberships
  WHERE account_id=p_account AND valid_until IS NULL;
 SELECT count(*) FILTER(WHERE state='uncertain'),
        count(*) FILTER(WHERE state='pending' AND created_at<statement_timestamp()-interval '5 minutes')
 INTO uncertain,old_pending FROM public.inbox_action_intents WHERE account_id=p_account;
 SELECT count(*) FILTER(WHERE state='claimed' AND claimed_at<statement_timestamp()-interval '5 minutes'),
        count(*) FILTER(WHERE state='review'),
        count(*) FILTER(WHERE state='awaiting_source'),
        count(*) FILTER(WHERE state='pending')
 INTO claimed_old,review,awaiting,effects_pending
 FROM public.inbox_canonical_effects WHERE account_id=p_account;
 -- Bounded to a 24-hour recent observation window. This is an anomaly
 -- signal, NOT a full historical consistency certification.
 SELECT count(*) INTO mismatch FROM public.inbox_message_memberships im
 LEFT JOIN public.inbox_threads it ON it.id=im.thread_id AND it.account_id=im.account_id
  AND it.channel_id=im.channel_id AND it.conversation_id=im.conversation_id
 WHERE im.account_id=p_account AND im.recorded_at>=statement_timestamp()-interval '24 hours'
 AND it.id IS NULL;
 SELECT count(*) INTO projected FROM public.inbox_message_memberships
 WHERE account_id=p_account AND recorded_at>=statement_timestamp()-interval '24 hours';
 RETURN jsonb_build_object(
  'read_only',true,'window','24h','sampled_at',statement_timestamp(),
  'threads',t,'active_memberships',active,
  'action_uncertain',uncertain,'action_pending_over_5m',old_pending,
  'effect_claimed_over_5m',claimed_old,'effect_review',review,
  'effect_awaiting_source',awaiting,'effect_pending',effects_pending,
  'recent_memberships',projected,'recent_orphan_memberships',mismatch);
END $$;
REVOKE ALL ON FUNCTION public.inbox_health_snapshot(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_health_snapshot(uuid,uuid) TO service_role;
