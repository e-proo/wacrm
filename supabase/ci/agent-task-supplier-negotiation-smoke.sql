-- SOF-66: supplier negotiation is a private, per-target durable protocol.
-- Structural and security contract verification; NO external provider call,
-- no Pilot activation and no permanent user data mutation.
BEGIN;
DO $verify$
DECLARE
  v_check text;
BEGIN
  IF to_regclass('public.ai_agent_coverage_supplier_negotiations') IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER_NEGOTIATION_TABLE_MISSING';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class
      WHERE oid='public.ai_agent_coverage_supplier_negotiations'::regclass) THEN
    RAISE EXCEPTION 'SUPPLIER_NEGOTIATION_RLS_MISSING';
  END IF;
  IF has_table_privilege('anon','public.ai_agent_coverage_supplier_negotiations','SELECT')
    OR has_table_privilege('authenticated','public.ai_agent_coverage_supplier_negotiations','SELECT')
    OR has_table_privilege('authenticated','public.ai_agent_coverage_supplier_negotiations','INSERT')
    OR has_table_privilege('authenticated','public.ai_agent_coverage_supplier_negotiations','UPDATE')
    OR NOT has_table_privilege('service_role','public.ai_agent_coverage_supplier_negotiations','INSERT')
    OR NOT has_table_privilege('service_role','public.ai_agent_coverage_supplier_negotiations','UPDATE') THEN
    RAISE EXCEPTION 'SUPPLIER_NEGOTIATION_PRIVATE_BOUNDARY_BROKEN';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
      WHERE conrelid='public.ai_agent_coverage_supplier_negotiations'::regclass
        AND contype='p')<>1 THEN
    RAISE EXCEPTION 'SUPPLIER_NEGOTIATION_PRIMARY_KEY_MISSING';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_check FROM pg_constraint
    WHERE conrelid='public.ai_agent_coverage_supplier_negotiations'::regclass
      AND conname='ai_agent_coverage_supplier_negotiations_stage_check';
  IF v_check IS NULL
    OR position('confirmation' in v_check)=0
    OR position('submitting' in v_check)=0
    OR position('submitted' in v_check)=0
    OR position('needs_human' in v_check)=0 THEN
    RAISE EXCEPTION 'SUPPLIER_NEGOTIATION_STATE_CONTRACT_MISSING: %',v_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ai_agent_coverage_supplier_negotiations'
      AND column_name='change_request_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ai_agent_coverage_supplier_negotiations'
      AND column_name='last_inbound_message_id'
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_PROPOSAL_LINEAGE_NOT_STORED';
  END IF;
  IF EXISTS(SELECT 1 FROM public.ai_agent_coverage_supplier_negotiations) THEN
    RAISE EXCEPTION 'MIGRATION_MUST_NOT_AUTO_SEED_NEGOTIATION_OR_SEND';
  END IF;
  RAISE NOTICE 'SOF-66 supplier negotiation boundary verified';
END $verify$;
ROLLBACK;
