-- SOF-66: explicit telephone WhatsApp opt-in stays scoped, short-lived,
-- server-only and separate from Meta's normal 24-hour/template policy.
-- This smoke performs no sends, no permanent writes, no Pilot activation.
BEGIN;
DO $$
DECLARE
  v_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='whatsapp_openwa_pilot_allowlist'
      AND column_name='consent_basis'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='whatsapp_openwa_pilot_allowlist'
      AND column_name='consent_attested_at'
  ) THEN
    RAISE EXCEPTION 'Phone-call opt-in columns missing';
  END IF;
  IF to_regprocedure('public.openwa_agent_phone_call_authorized(uuid,uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Agent telephone opt-in helper missing';
  END IF;
  IF has_function_privilege('anon',
      'public.openwa_agent_phone_call_authorized(uuid,uuid,uuid,uuid)', 'EXECUTE')
    OR has_function_privilege('authenticated',
      'public.openwa_agent_phone_call_authorized(uuid,uuid,uuid,uuid)', 'EXECUTE')
    OR NOT has_function_privilege('service_role',
      'public.openwa_agent_phone_call_authorized(uuid,uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Telephone opt-in helper privilege leak';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='openwa_agent_phone_call_authorized'
      AND p.prosecdef=false AND p.prosrc LIKE '%a.consent_basis=%'
      AND p.prosrc LIKE '%a.workload=%'
      AND p.prosrc LIKE '%g.manual_paused IS FALSE%'
      AND p.prosrc LIKE '%wc.provider=%'
      AND p.prosrc LIKE '%a.expires_at>now()%'
  ) THEN
    RAISE EXCEPTION 'Scoped telephone opt-in helper guard contract changed';
  END IF;
  FOREACH v_name IN ARRAY ARRAY[
    'reserve_agent_task_outbound_message',
    'claim_agent_task_outbound_message',
    'reserve_bound_agent_task_outbound_message',
    'claim_bound_agent_task_outbound_message'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=v_name
        AND p.prosrc LIKE '%openwa_agent_phone_call_authorized%'
    ) THEN
      RAISE EXCEPTION 'Outbound SQL gate lacks telephone consent check: %',v_name;
    END IF;
  END LOOP;
  IF public.openwa_agent_phone_call_authorized(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444'
  ) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Unapproved foreign identity allowed';
  END IF;
END $$;
ROLLBACK;
