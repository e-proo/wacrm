-- TEST Pilot operator caps + usage/tenant/privacy contract.
-- Read-only smoke. No capacity mutation, approval, or WhatsApp send.
BEGIN;
DO $check$
DECLARE v_rule record; v_ddl text; v_rpc text;
BEGIN
  FOR v_rule IN SELECT * FROM (VALUES
    ('pilot_agent_hourly_cap'),
    ('pilot_agent_daily_cap'),
    ('pilot_manual_hourly_cap'),
    ('pilot_manual_daily_cap')
  ) AS t(col)
  LOOP
    SELECT pg_get_constraintdef(c.oid) INTO v_ddl
      FROM pg_constraint c
      WHERE c.conrelid='public.whatsapp_connection_guardrails'::regclass
        AND c.conname='whatsapp_connection_guardrails_'||v_rule.col||'_check';
    IF v_ddl IS NULL OR
       position('('||v_rule.col||' >= 1)' IN v_ddl)=0 OR
       position(v_rule.col||' <=' IN v_ddl)>0 THEN
      RAISE EXCEPTION 'OpenWA TEST configurable cap contract mismatch for % (ddl: %)',v_rule.col,v_ddl;
    END IF;
  END LOOP;
  SELECT pg_get_constraintdef(c.oid) INTO v_ddl FROM pg_constraint c
   WHERE c.conrelid='public.whatsapp_connection_guardrails'::regclass
     AND c.conname='whatsapp_connection_guardrails_hourly_cap_check';
  IF v_ddl IS NULL OR position('pilot_enabled IS TRUE' IN v_ddl)=0
    OR position('hourly_cap <= 10000' IN v_ddl)=0 THEN
     RAISE EXCEPTION 'Non-pilot hourly cap is no longer protected: %',v_ddl;
  END IF;
  SELECT pg_get_constraintdef(c.oid) INTO v_ddl FROM pg_constraint c
   WHERE c.conrelid='public.whatsapp_connection_guardrails'::regclass
     AND c.conname='whatsapp_connection_guardrails_daily_cap_check';
  IF v_ddl IS NULL OR position('pilot_enabled IS TRUE' IN v_ddl)=0
    OR position('daily_cap <= 100000' IN v_ddl)=0 THEN
     RAISE EXCEPTION 'Non-pilot daily cap is no longer protected: %',v_ddl;
  END IF;
  IF has_table_privilege('anon','public.whatsapp_connection_guardrails','UPDATE')
    OR has_table_privilege('authenticated','public.whatsapp_connection_guardrails','UPDATE')
    OR NOT has_table_privilege('service_role','public.whatsapp_connection_guardrails','UPDATE') THEN
     RAISE EXCEPTION 'Guardrail table write privilege leak';
  END IF;
  IF has_function_privilege('anon','public.get_openwa_test_guardrail_usage(uuid,uuid)','EXECUTE')
    OR has_function_privilege('authenticated','public.get_openwa_test_guardrail_usage(uuid,uuid)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.get_openwa_test_guardrail_usage(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'TEST aggregate usage RPC privilege leak';
  END IF;
  SELECT pg_get_functiondef('public.get_openwa_test_guardrail_usage(uuid,uuid)'::regprocedure)
    INTO v_rpc;
  IF (SELECT p.prosecdef FROM pg_proc p
       WHERE p.oid='public.get_openwa_test_guardrail_usage(uuid,uuid)'::regprocedure)
     OR position('account_id=p_account_id' IN v_rpc)=0
     OR position('connection_id=p_connection_id' IN v_rpc)=0 THEN
    RAISE EXCEPTION 'TEST usage RPC missing scoped read-only contract';
  END IF;
  IF public.get_openwa_test_guardrail_usage(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222') IS NOT NULL THEN
    RAISE EXCEPTION 'Unknown tenant unexpectedly received usage details';
  END IF;
  RAISE NOTICE 'OpenWA TEST configurable caps, non-pilot ceilings and usage privacy passed';
END $check$;
ROLLBACK;
