-- INBOX-5 / SOF-87 security verification. Fully reversible TEST/CI fixture.
BEGIN;
DO $smoke$
DECLARE
 u1 uuid:='00000000-0000-4000-8000-000000005871';
 u2 uuid:='00000000-0000-4000-8000-000000005872';
 a1 uuid; a2 uuid; j jsonb;
BEGIN
 IF has_function_privilege('anon','public.inbox_health_snapshot(uuid,uuid)','EXECUTE')
 OR has_function_privilege('authenticated','public.inbox_health_snapshot(uuid,uuid)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.inbox_health_snapshot(uuid,uuid)','EXECUTE')
 OR has_function_privilege('anon','public.inbox_claim_action(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text)','EXECUTE')
 OR has_function_privilege('authenticated','public.inbox_claim_action(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text)','EXECUTE')
 OR has_table_privilege('authenticated','public.inbox_action_intents','SELECT')
 THEN RAISE EXCEPTION 'INBOX5_PRIVILEGE_LEAK'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.inbox_health_snapshot(uuid,uuid)'::regprocedure AND NOT prosecdef) THEN RAISE EXCEPTION 'INBOX5_HEALTH_NOT_INVOKER'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='inbox_guard_action_source' AND tgrelid='public.messages'::regclass AND tgenabled='O') THEN RAISE EXCEPTION 'INBOX5_SOURCE_GUARD'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.inbox_action_intents'::regclass)
 OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.inbox_message_memberships'::regclass)
 THEN RAISE EXCEPTION 'INBOX5_RLS'; END IF;
 INSERT INTO auth.users(id,email,raw_user_meta_data)
 VALUES(u1,'inbox587-owner@example.test','{"full_name":"SOF87"}'),
       (u2,'inbox587-other@example.test','{"full_name":"Other"}');
 SELECT account_id INTO STRICT a1 FROM public.profiles WHERE user_id=u1;
 SELECT account_id INTO STRICT a2 FROM public.profiles WHERE user_id=u2;
 UPDATE public.profiles SET account_role='admin' WHERE user_id=u1;
 j=public.inbox_health_snapshot(a1,u1);
 IF j->>'read_only'<>'true' OR j->>'window'<>'24h'
 OR (j->>'threads')::bigint<>0 OR j ? 'recipient' OR j ? 'message'
 OR j ? 'native_message_id' OR j ? 'access_token' OR j ? 'account_id' OR j ? 'actor_id'
 THEN RAISE EXCEPTION 'INBOX5_REDACTED_AGGREGATE %',j; END IF;
 IF a1=a2 THEN RAISE EXCEPTION 'INBOX5_TENANT_SETUP'; END IF;
 BEGIN
  PERFORM public.inbox_health_snapshot(a2,u1);
  RAISE EXCEPTION 'INBOX5_CROSS_TENANT_ACCEPTED';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 UPDATE public.profiles SET account_role='viewer' WHERE user_id=u1;
 BEGIN
  PERFORM public.inbox_health_snapshot(a1,u1);
  RAISE EXCEPTION 'INBOX5_VIEWER_ACCEPTED';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 UPDATE public.profiles SET account_role='agent' WHERE user_id=u1;
 BEGIN
  PERFORM public.inbox_health_snapshot(a1,u1);
  RAISE EXCEPTION 'INBOX5_AGENT_ACCEPTED';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 IF (SELECT COUNT(*) FROM public.inbox_action_intents WHERE account_id=a1)>0 THEN RAISE EXCEPTION 'INBOX5_NO_SEND'; END IF;
END $smoke$;
ROLLBACK;
