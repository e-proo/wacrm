BEGIN;

DO $schema$
BEGIN
  IF to_regclass('public.whatsapp_openwa_pilot_allowlist') IS NULL
     OR to_regclass('public.whatsapp_openwa_pilot_admission_events') IS NULL THEN
    RAISE EXCEPTION 'OW-13 pilot admission tables missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.whatsapp_openwa_pilot_allowlist'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.whatsapp_openwa_pilot_admission_events'::regclass) THEN
    RAISE EXCEPTION 'OW-13 RLS must be enabled';
  END IF;
  IF has_table_privilege('anon','public.whatsapp_openwa_pilot_allowlist','SELECT')
     OR has_table_privilege('authenticated','public.whatsapp_openwa_pilot_allowlist','SELECT')
     OR has_table_privilege('authenticated','public.whatsapp_openwa_pilot_allowlist','INSERT')
     OR has_table_privilege('anon','public.whatsapp_openwa_pilot_admission_events','SELECT')
     OR has_table_privilege('authenticated','public.whatsapp_openwa_pilot_admission_events','SELECT') THEN
    RAISE EXCEPTION 'OW-13 client table privileges leaked';
  END IF;
  IF has_function_privilege('anon','public.check_openwa_pilot_admission(uuid,uuid,text,text)','EXECUTE')
    OR has_function_privilege('authenticated','public.check_openwa_pilot_admission(uuid,uuid,text,text)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.check_openwa_pilot_admission(uuid,uuid,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'OW-13 RPC privilege boundary broken';
  END IF;
  IF (SELECT count(*) FROM public.whatsapp_openwa_pilot_allowlist) <> 0 THEN
    RAISE EXCEPTION 'OW-13 migration must not seed/activate a pilot';
  END IF;
END
$schema$;

DO $fixtures$
DECLARE
  v_account uuid;
  v_other uuid;
  v_conn uuid := '11111111-2222-4333-8444-555555555555';
  v_operator uuid := '00000000-0000-4000-8000-000000001301';
  v_result jsonb;
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data)
  VALUES (v_operator,'ow13-pilot-operator@example.test','{"full_name":"OW13 Operator"}'::jsonb);
  INSERT INTO auth.users(id,email,raw_user_meta_data)
  VALUES ('00000000-0000-4000-8000-000000001302','ow13-outsider@example.test','{"full_name":"OW13 Other"}'::jsonb);

  SELECT account_id INTO STRICT v_account FROM public.profiles WHERE user_id=v_operator;
  SELECT account_id INTO STRICT v_other FROM public.profiles WHERE user_id='00000000-0000-4000-8000-000000001302';

  INSERT INTO public.whatsapp_connections(id,account_id,provider,status,session_id,engine)
  VALUES (v_conn,v_account,'openwa','ready','ow13-synthetic-session','whatsapp-web.js');

  SELECT public.check_openwa_pilot_admission(v_account,v_conn,repeat('a',64),'manual') INTO v_result;
  IF v_result->>'allowed' <> 'false' OR v_result->>'reason' <> 'not_allowlisted' THEN
    RAISE EXCEPTION 'Missing allowlist must deny by default: %',v_result;
  END IF;

  INSERT INTO public.whatsapp_openwa_pilot_allowlist
    (account_id,connection_id,recipient_hash,workload,approved_by,expires_at)
  VALUES (v_account,v_conn,repeat('a',64),'manual',v_operator,now()+interval '1 day');
  -- The SQL default 'active=false' is the first independent activation fence.
  SELECT public.check_openwa_pilot_admission(v_account,v_conn,repeat('a',64),'manual') INTO v_result;
  IF v_result->>'allowed' <> 'false' THEN
    RAISE EXCEPTION 'Inactive policy unexpectedly allowed a pilot send: %',v_result;
  END IF;

  UPDATE public.whatsapp_openwa_pilot_allowlist SET active=true
  WHERE connection_id=v_conn AND account_id=v_account AND workload='manual';

  SELECT public.check_openwa_pilot_admission(v_account,v_conn,repeat('a',64),'manual') INTO v_result;
  IF v_result->>'allowed' <> 'true' THEN
    RAISE EXCEPTION 'Active approved recipient/workload should pass: %',v_result;
  END IF;

  SELECT public.check_openwa_pilot_admission(v_account,v_conn,repeat('a',64),'broadcast') INTO v_result;
  IF v_result->>'allowed' <> 'false' THEN
    RAISE EXCEPTION 'Workload escalation escaped pilot allowlist: %',v_result;
  END IF;

  SELECT public.check_openwa_pilot_admission(v_other,v_conn,repeat('a',64),'manual') INTO v_result;
  IF v_result->>'allowed' <> 'false' OR v_result->>'reason' <> 'connection_scope_mismatch' THEN
    RAISE EXCEPTION 'Cross-tenant admission escaped scope: %',v_result;
  END IF;

  SELECT public.check_openwa_pilot_admission(v_account,v_conn,repeat('b',64),'manual') INTO v_result;
  IF v_result->>'allowed' <> 'false' THEN
    RAISE EXCEPTION 'Unapproved recipient escaped pilot allowlist: %',v_result;
  END IF;

  SELECT public.check_openwa_pilot_admission(v_account,v_conn,'recipient-in-plaintext','manual') INTO v_result;
  IF v_result->>'allowed' <> 'false' THEN
    RAISE EXCEPTION 'Malformed recipient hash escaped admission: %',v_result;
  END IF;

  UPDATE public.whatsapp_openwa_pilot_allowlist SET approved_at=now()-interval '2 days', expires_at=now()-interval '1 day'
  WHERE connection_id=v_conn AND account_id=v_account;
  SELECT public.check_openwa_pilot_admission(v_account,v_conn,repeat('a',64),'manual') INTO v_result;
  IF v_result->>'allowed' <> 'false' THEN
    RAISE EXCEPTION 'Expired permission escaped pilot admission: %',v_result;
  END IF;

  IF (SELECT count(*) FROM public.whatsapp_openwa_pilot_admission_events
      WHERE connection_id=v_conn AND account_id=v_account AND reason='approved') <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one successful admission audit record';
  END IF;
  IF EXISTS (SELECT 1 FROM public.whatsapp_openwa_pilot_admission_events
             WHERE recipient_hash IS NOT NULL AND recipient_hash !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'Unsafe recipient identity stored in pilot admission audit';
  END IF;
  RAISE NOTICE 'OW-13 server-only allowlist/tenant/expiry smoke passed';
END
$fixtures$;

ROLLBACK;
