-- Regression contract for the TEST-only bounded split workloads.
BEGIN;
DO $$
BEGIN
  IF to_regprocedure('public.reserve_openwa_pilot_workload_send(uuid,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'TEST pilot bounded workload reservation missing';
  END IF;
  IF has_function_privilege('anon','public.reserve_openwa_pilot_workload_send(uuid,uuid,text,text)','EXECUTE')
    OR has_function_privilege('authenticated','public.reserve_openwa_pilot_workload_send(uuid,uuid,text,text)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.reserve_openwa_pilot_workload_send(uuid,uuid,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'TEST pilot workload RPC privilege leak';
  END IF;
  IF has_table_privilege('anon','public.whatsapp_connection_guardrails','UPDATE')
    OR has_table_privilege('authenticated','public.whatsapp_openwa_pilot_allowlist','INSERT') THEN
    RAISE EXCEPTION 'TEST pilot guardrail or recipient admission client write leak';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='whatsapp_connection_guardrails'
      AND column_name='pilot_agent_hourly_cap') THEN
    RAISE EXCEPTION 'TEST pilot per-workload caps absent';
  END IF;
  IF (public.reserve_openwa_pilot_workload_send(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    repeat('a',64),'agent')->>'allowed') <> 'false' THEN
    RAISE EXCEPTION 'Unconfigured TEST pilot scope unexpectedly admitted a send';
  END IF;
END $$;
ROLLBACK;
