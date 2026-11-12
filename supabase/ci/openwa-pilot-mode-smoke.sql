-- TEST Pilot switch: role isolation, tenant scoping and reversible mode.
BEGIN;

DO $test$
DECLARE
  v_account uuid;
  v_other uuid;
  v_conn uuid := '11111111-2222-4333-8444-555555555556';
  v_actor uuid := '00000000-0000-4000-8000-000000001561';
  v_result jsonb;
BEGIN
  IF to_regclass('public.whatsapp_openwa_pilot_mode_events') IS NULL THEN
    RAISE EXCEPTION 'Pilot mode audit ledger absent';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.whatsapp_openwa_pilot_mode_events'::regclass) THEN
    RAISE EXCEPTION 'Pilot mode audit ledger must have RLS enabled';
  END IF;
  IF has_table_privilege('anon','public.whatsapp_openwa_pilot_mode_events','SELECT')
    OR has_table_privilege('authenticated','public.whatsapp_openwa_pilot_mode_events','INSERT')
    OR has_function_privilege('anon','public.set_openwa_test_pilot_mode(uuid,uuid,uuid,boolean,boolean,boolean)','EXECUTE')
    OR has_function_privilege('authenticated','public.set_openwa_test_pilot_mode(uuid,uuid,uuid,boolean,boolean,boolean)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.set_openwa_test_pilot_mode(uuid,uuid,uuid,boolean,boolean,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'Pilot mode privilege boundary leaked';
  END IF;
  INSERT INTO auth.users(id,email,raw_user_meta_data)
  VALUES (v_actor,'ow13-toggle-operator@example.test','{"full_name":"Toggle Operator"}'::jsonb);
  INSERT INTO auth.users(id,email,raw_user_meta_data)
  VALUES ('00000000-0000-4000-8000-000000001562','ow13-toggle-other@example.test','{"full_name":"Other"}'::jsonb);

  SELECT account_id INTO STRICT v_account FROM public.profiles WHERE user_id = v_actor;
  SELECT account_id INTO STRICT v_other FROM public.profiles
    WHERE user_id = '00000000-0000-4000-8000-000000001562';
  INSERT INTO public.whatsapp_connections(id,account_id,provider,status,session_id,engine)
  VALUES (v_conn,v_account,'openwa','ready','ow13-toggle-test-session','whatsapp-web.js');
  INSERT INTO public.whatsapp_connection_guardrails(account_id,connection_id,manual_paused)
  VALUES (v_account,v_conn,true);
  IF (SELECT pilot_enabled FROM public.whatsapp_connection_guardrails WHERE connection_id=v_conn) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Pilot default must be protected';
  END IF;

  SELECT public.set_openwa_test_pilot_mode(v_other,v_conn,v_actor,false,true,false) INTO v_result;
  IF v_result->>'updated' <> 'false' THEN
    RAISE EXCEPTION 'Cross-account mode toggle must be denied: %',v_result;
  END IF;
  SELECT public.set_openwa_test_pilot_mode(v_account,v_conn,v_actor,false,false,false) INTO v_result;
  IF v_result->>'updated' <> 'false' THEN
    RAISE EXCEPTION 'Normal sending requires explicit confirmation: %',v_result;
  END IF;
  SELECT public.set_openwa_test_pilot_mode(v_account,v_conn,v_actor,false,true,false) INTO v_result;
  IF v_result->>'updated' <> 'true' THEN
    RAISE EXCEPTION 'Verified normal-mode transition failed: %',v_result;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_connection_guardrails
    WHERE connection_id=v_conn AND account_id=v_account AND pilot_enabled=false
      AND manual_paused=false AND hourly_cap=60 AND daily_cap=500) THEN
    RAISE EXCEPTION 'Normal mode did not restore OW-10 limits';
  END IF;
  SELECT public.set_openwa_test_pilot_mode(v_account,v_conn,v_actor,true,false,false) INTO v_result;
  IF v_result->>'updated' <> 'true' THEN
    RAISE EXCEPTION 'Pilot reactivation failed: %',v_result;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_connection_guardrails
    WHERE connection_id=v_conn AND pilot_enabled=true AND manual_paused=true
      AND hourly_cap=3 AND daily_cap=10) THEN
    RAISE EXCEPTION 'Re-enabled Pilot must be paused with strict caps';
  END IF;
  IF (SELECT count(*) FROM public.whatsapp_openwa_pilot_mode_events
      WHERE account_id=v_account AND connection_id=v_conn AND changed_by=v_actor) <> 2 THEN
    RAISE EXCEPTION 'Expected exactly two auditable mode changes';
  END IF;
  RAISE NOTICE 'TEST pilot toggle mode/tenant/RLS smoke passed';
END
$test$;

ROLLBACK;
