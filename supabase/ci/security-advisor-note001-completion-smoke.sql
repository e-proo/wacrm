-- NOTE-001; run after migrations 199-200. All fixture mutations roll back.
BEGIN;
DO $verify$
DECLARE n integer;
BEGIN
 SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace
 WHERE s.nspname='public' AND p.prosecdef AND
 (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'));
 IF n<>0 THEN RAISE EXCEPTION 'Public executable definer functions: %',n; END IF;
 SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace
 WHERE s.nspname='public' AND NOT p.prosecdef
 AND p.proname=ANY(ARRAY['create_message_template_revision','publish_ai_agent_revision_atomic','publish_message_template_revision','redeem_invitation','remove_account_member','replace_ai_agent_knowledge_base_assignments','set_member_role','set_trusted_admin_capabilities','touch_presence','transfer_account_ownership','unpublish_message_template'])
 AND has_function_privilege('authenticated',p.oid,'EXECUTE')
 AND NOT has_function_privilege('anon',p.oid,'EXECUTE');
 IF n<>11 THEN RAISE EXCEPTION 'Expected 11 signed-in invoker facades, got %',n; END IF;
 SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace
 WHERE s.nspname='wacrm_internal' AND p.prosecdef
 AND p.proname=ANY(ARRAY['create_message_template_revision','publish_ai_agent_revision_atomic','publish_message_template_revision','redeem_invitation','remove_account_member','replace_ai_agent_knowledge_base_assignments','set_member_role','set_trusted_admin_capabilities','touch_presence','transfer_account_ownership','unpublish_message_template'])
 AND NOT has_function_privilege('anon',p.oid,'EXECUTE');
 IF n<>11 THEN RAISE EXCEPTION 'Expected 11 protected private implementations, got %',n; END IF;
 -- The three private template engines must also reject missing actor JWTs:
 -- the public facades alone must never be the only security boundary.
 SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace
 WHERE s.nspname='wacrm_internal' AND p.prosecdef
   AND p.proname=ANY(ARRAY[
     'create_message_template_revision',
     'publish_message_template_revision',
     'unpublish_message_template'
   ])
   AND position('MESSAGE_TEMPLATE_AUTH_REQUIRED' in pg_get_functiondef(p.oid))>0;
 IF n<>3 THEN RAISE EXCEPTION 'Internal template actor guards missing: %',n; END IF;
 IF has_schema_privilege('anon','wacrm_internal','USAGE')
    OR has_function_privilege('anon','wacrm_internal.touch_presence(text)','EXECUTE') THEN
   RAISE EXCEPTION 'Anonymous internal schema exposure'; END IF;
 SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace
 WHERE s.nspname='public' AND p.proname=ANY(ARRAY['_bcast_cols_for_status','update_updated_at_column','update_ai_configs_updated_at','update_ai_knowledge_documents_updated_at','update_trusted_admin_identities_updated_at','update_ai_provider_connections_updated_at','update_service_categories_updated_at','update_services_updated_at','update_coverage_offers_updated_at','update_coverage_requests_updated_at','update_currencies_updated_at','trg_seed_default_currencies_on_account','update_ai_reconciliation_jobs_updated_at','update_coverage_regions_updated_at','trg_seed_default_coverage_regions_on_account','trg_seed_default_coverage_service_on_account'])
 AND p.proconfig IS NOT NULL;
 IF n<>16 THEN RAISE EXCEPTION 'Expected 16 immutable paths, got %',n; END IF;
 SELECT count(*) INTO n FROM pg_policies pol WHERE pol.schemaname='public'
 AND pol.tablename=ANY(ARRAY['ai_agent_coverage_supplier_negotiations','ai_agent_task_scheduler_heartbeat','ai_agent_task_trigger_claim_fairness','ai_agent_task_worker_control_events','automation_pending_executions','broadcast_delivery_jobs','openwa_deferred_events','openwa_outbound_operator_reviews','whatsapp_connection_guardrails','whatsapp_guardrail_events','whatsapp_openwa_pilot_admission_events','whatsapp_openwa_pilot_allowlist','whatsapp_openwa_pilot_mode_events'])
 AND pol.roles=ARRAY['service_role']::name[] AND pol.cmd='ALL';
 IF n<>13 THEN RAISE EXCEPTION 'Expected 13 service-role policies, got %',n; END IF;
 IF (SELECT count(*) FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
    WHERE s.nspname='public' AND c.relkind='r' AND c.relrowsecurity
    AND NOT EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid=c.oid))<>0 THEN
   RAISE EXCEPTION 'An RLS-enabled table has no policy'; END IF;
 IF (SELECT s.nspname FROM pg_extension e JOIN pg_namespace s ON e.extnamespace=s.oid
    WHERE e.extname='vector')<>'extensions' THEN
   RAISE EXCEPTION 'vector extension not relocated'; END IF;
 IF has_table_privilege('anon','public.automation_pending_executions','SELECT')
    OR has_table_privilege('authenticated','public.automation_pending_executions','SELECT') THEN
   RAISE EXCEPTION 'Worker queue table ACL broadened'; END IF;
END $verify$;
DO $fixture$
DECLARE u uuid:=gen_random_uuid(); a uuid;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data)
 VALUES(u,'security-note001-'||u::text||'@example.test','{"full_name":"NOTE001 test"}'::jsonb);
 SELECT account_id INTO a FROM public.profiles WHERE user_id=u;
 IF a IS NULL OR NOT EXISTS(SELECT 1 FROM public.accounts WHERE id=a AND owner_user_id=u)
 THEN RAISE EXCEPTION 'Signup trigger or account bootstrap regressed'; END IF;
 PERFORM set_config('note001.uid',u::text,true);
 PERFORM set_config('note001.account',a::text,true);
END $fixture$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',current_setting('note001.uid'),true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
DO $authenticated$
DECLARE a uuid:=current_setting('note001.account')::uuid;
BEGIN
 IF NOT public.is_account_member(a,'owner') OR public.is_account_member(gen_random_uuid(),'viewer')
 THEN RAISE EXCEPTION 'Membership isolation regressed'; END IF;
 PERFORM public.touch_presence('online');
 -- A clean DB intentionally may not grant SELECT on member_presence to
 -- authenticated; assert the write as postgres after RESET ROLE instead.
 BEGIN
   PERFORM public.redeem_invitation('note001-invalid-invitation');
   RAISE EXCEPTION 'Invalid invitation redeemed';
 EXCEPTION WHEN sqlstate '22023' THEN NULL;
 END;
 BEGIN
   PERFORM public.publish_ai_agent_revision_atomic(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),1,auth.uid());
   RAISE EXCEPTION 'Cross-account agent publish allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
   PERFORM * FROM public.create_message_template_revision(gen_random_uuid(),'note001','customer','whatsapp','ar','test');
   RAISE EXCEPTION 'Cross-account template creation allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $authenticated$;
RESET ROLE;
DO $presence_assert$
BEGIN
 IF NOT EXISTS(
   SELECT 1 FROM public.member_presence
   WHERE account_id=current_setting('note001.account')::uuid
     AND user_id=current_setting('note001.uid')::uuid
     AND status='online'
 ) THEN RAISE EXCEPTION 'Signed-in presence RPC failed'; END IF;
END $presence_assert$;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claim.role','anon',true);
DO $anonymous$
BEGIN
 IF has_function_privilege('anon','public.redeem_invitation(text)','EXECUTE')
    OR has_function_privilege('anon','public.touch_presence(text)','EXECUTE')
 THEN RAISE EXCEPTION 'Anonymous privileged RPC exposed'; END IF;
END $anonymous$;
RESET ROLE;
SELECT count(*) AS semantic_parse_works
 FROM public.match_ai_knowledge_semantic(
 gen_random_uuid(),'['||array_to_string(array_fill(0,ARRAY[1536]),',')||']',1,null);
-- V2 knowledge search must also retain its ::vector and <=> operators.
SELECT count(*) AS v2_semantic_parse_works
 FROM public.match_ai_knowledge_v2_semantic(
 gen_random_uuid(),gen_random_uuid(),
 '['||array_to_string(array_fill(0,ARRAY[1536]),',')||']',
 1,null,null,null);
ROLLBACK;
