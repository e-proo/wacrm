-- TEST-only OpenWA Pilot cap schema regression. No sends, grants or persistent data.
BEGIN;
DO $check$
DECLARE
  v_rule record;
  v_ddl text;
BEGIN
  FOR v_rule IN
    SELECT * FROM (VALUES
      ('pilot_agent_hourly_cap', 100),
      ('pilot_agent_daily_cap', 1000),
      ('pilot_manual_hourly_cap', 100),
      ('pilot_manual_daily_cap', 1000)
    ) AS t(col, upper_bound)
  LOOP
    SELECT pg_get_constraintdef(c.oid) INTO v_ddl
    FROM pg_constraint c
    WHERE c.conrelid='public.whatsapp_connection_guardrails'::regclass
      AND c.conname='whatsapp_connection_guardrails_'||v_rule.col||'_check';
    IF v_ddl IS NULL OR
      position('('||v_rule.col||' >= 1)' IN v_ddl)=0 OR
      position('('||v_rule.col||' <= '||v_rule.upper_bound::text||')' IN v_ddl)=0
    THEN
      RAISE EXCEPTION 'OpenWA TEST Pilot cap contract mismatch for % (ddl: %)',
        v_rule.col,v_ddl;
    END IF;
  END LOOP;

  IF has_table_privilege('anon','public.whatsapp_connection_guardrails','UPDATE')
     OR has_table_privilege('authenticated','public.whatsapp_connection_guardrails','UPDATE')
     OR NOT has_table_privilege('service_role','public.whatsapp_connection_guardrails','UPDATE') THEN
    RAISE EXCEPTION 'OpenWA TEST Pilot cap schema leaked update privilege';
  END IF;

  IF has_function_privilege('anon','public.reserve_openwa_pilot_workload_send(uuid,uuid,text,text)','EXECUTE')
    OR has_function_privilege('authenticated','public.reserve_openwa_pilot_workload_send(uuid,uuid,text,text)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.reserve_openwa_pilot_workload_send(uuid,uuid,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'OpenWA TEST Pilot workload reservation privilege leak';
  END IF;
END $check$;
ROLLBACK;
