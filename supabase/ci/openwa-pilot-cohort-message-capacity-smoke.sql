-- TEST Pilot cohort planning contract; read-only assertions, no grants or sends.
BEGIN;
DO $verify$
DECLARE
  v_default text;
  v_definition text;
BEGIN
  SELECT column_default INTO v_default
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='whatsapp_openwa_pilot_allowlist'
    AND column_name='messages_per_recipient';
  IF v_default IS DISTINCT FROM '1'::text THEN
    RAISE EXCEPTION 'TEST Pilot legacy grants must keep 1-message default: %', v_default;
  END IF;
  SELECT pg_get_constraintdef(c.oid) INTO v_definition
  FROM pg_constraint c
  WHERE c.conrelid='public.whatsapp_openwa_pilot_allowlist'::regclass
    AND c.conname='whatsapp_openwa_pilot_messages_per_recipient_check';
  IF v_definition IS NULL
     OR position('messages_per_recipient >= 1' IN v_definition)=0
     OR position('messages_per_recipient <= 100' IN v_definition)=0 THEN
    RAISE EXCEPTION 'TEST Pilot per-recipient bounded capacity CHECK missing: %',v_definition;
  END IF;

  IF has_table_privilege('anon','public.whatsapp_openwa_pilot_allowlist','SELECT')
     OR has_table_privilege('authenticated','public.whatsapp_openwa_pilot_allowlist','SELECT')
     OR has_table_privilege('anon','public.whatsapp_openwa_pilot_allowlist','UPDATE')
     OR has_table_privilege('authenticated','public.whatsapp_openwa_pilot_allowlist','UPDATE')
     OR NOT has_table_privilege('service_role','public.whatsapp_openwa_pilot_allowlist','UPDATE') THEN
    RAISE EXCEPTION 'TEST pilot recipient-capacity admin-only privacy boundary failed';
  END IF;
END $verify$;
ROLLBACK;
