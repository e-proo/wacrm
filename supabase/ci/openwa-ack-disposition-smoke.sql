BEGIN;
DO $verify$
DECLARE v_test jsonb;
BEGIN
  IF to_regprocedure('public.close_openwa_unmatched_ack(uuid,uuid,uuid,uuid,text,text,boolean)') IS NULL
  THEN RAISE EXCEPTION 'Missing ACK disposition API'; END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid=
      'public.close_openwa_unmatched_ack(uuid,uuid,uuid,uuid,text,text,boolean)'::regprocedure)
    OR has_function_privilege('anon',
      'public.close_openwa_unmatched_ack(uuid,uuid,uuid,uuid,text,text,boolean)','EXECUTE')
    OR has_function_privilege('authenticated',
      'public.close_openwa_unmatched_ack(uuid,uuid,uuid,uuid,text,text,boolean)','EXECUTE')
    OR NOT has_function_privilege('service_role',
      'public.close_openwa_unmatched_ack(uuid,uuid,uuid,uuid,text,text,boolean)','EXECUTE')
  THEN RAISE EXCEPTION 'ACK close RPC client privilege/definer boundary failed'; END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class
        WHERE oid='public.openwa_ack_disposition_audit'::regclass)
    OR has_table_privilege('anon','public.openwa_ack_disposition_audit','SELECT')
    OR has_table_privilege('authenticated','public.openwa_ack_disposition_audit','INSERT')
    OR has_table_privilege('service_role','public.openwa_ack_disposition_audit','UPDATE')
    OR has_table_privilege('service_role','public.openwa_ack_disposition_audit','DELETE')
  THEN RAISE EXCEPTION 'ACK audit must be RLS + append-only service-role'; END IF;

  SELECT public.close_openwa_unmatched_ack(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
    'no_verified_evidence',NULL,true) INTO v_test;
  IF v_test->>'updated'<>'false' OR v_test->>'reason'<>'actor_forbidden'
  THEN RAISE EXCEPTION 'ACK disposition accepted fake actor'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
    conname='openwa_ack_disposition_shape'
    AND conrelid='public.openwa_deferred_events'::regclass)
  THEN RAISE EXCEPTION 'Missing disjoint closed versus active disposition shape'; END IF;
  IF (SELECT position('closed_unverified' IN pg_get_functiondef(
    'public.claim_openwa_deferred_events(integer)'::regprocedure)))>0
  THEN RAISE EXCEPTION 'Deferred claim unexpectedly scans terminal unverified ACKs'; END IF;
  RAISE NOTICE 'OW14-W05 ACK disposition boundary smoke passed';
END $verify$;
ROLLBACK;
