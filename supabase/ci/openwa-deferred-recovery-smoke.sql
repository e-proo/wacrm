BEGIN;

-- Validate additive deferred OpenWA identity/ACK recovery on a clean DB.
DO $deferred$
DECLARE v_fn regprocedure;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class
    WHERE oid='public.openwa_deferred_events'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'OpenWA deferred event RLS missing';
  END IF;
  IF has_table_privilege('anon','public.openwa_deferred_events','SELECT')
    OR has_table_privilege('authenticated','public.openwa_deferred_events','SELECT')
    OR has_table_privilege('anon','public.openwa_deferred_events','INSERT')
    OR has_table_privilege('authenticated','public.openwa_deferred_events','UPDATE')
    OR NOT has_table_privilege('service_role','public.openwa_deferred_events','SELECT')
    OR NOT has_table_privilege('service_role','public.openwa_deferred_events','UPDATE') THEN
    RAISE EXCEPTION 'OpenWA deferred queue privilege boundary missing';
  END IF;
  FOR v_fn IN
    SELECT unnest(ARRAY[
      'public.defer_openwa_webhook_event(uuid,uuid,text,text,text,text,text,jsonb,uuid)'::regprocedure,
      'public.claim_openwa_deferred_events(integer)'::regprocedure,
      'public.finish_openwa_deferred_event(uuid,uuid,text,integer,text)'::regprocedure,
      'public.prune_openwa_deferred_events(integer)'::regprocedure
    ])
  LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_fn)
      OR has_function_privilege('authenticated',v_fn::oid,'EXECUTE')
      OR has_function_privilege('anon',v_fn::oid,'EXECUTE')
      OR NOT has_function_privilege('service_role',v_fn::oid,'EXECUTE')
    THEN
      RAISE EXCEPTION 'OpenWA deferred RPC is not service-only: %',v_fn;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
    WHERE tablename='openwa_deferred_events' AND indexname='openwa_deferred_due_idx') THEN
    RAISE EXCEPTION 'OpenWA deferred due-work index missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname='openwa_deferred_event_identity'
      AND conrelid='public.openwa_deferred_events'::regclass) THEN
    RAISE EXCEPTION 'OpenWA signed event dedupe constraint missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='openwa_deferred_events'
      AND column_name='verified_phone'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.openwa_deferred_events'::regclass
      AND conname='openwa_deferred_verified_phone_proof'
  ) THEN
    RAISE EXCEPTION 'Provider verified phone proof schema missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='claim_openwa_deferred_events'
      AND position('verified_phone' in pg_get_function_result(p.oid)) > 0
  ) THEN
    RAISE EXCEPTION 'Deferred claim must expose verified phone proof to worker';
  END IF;
  -- Strict bounds prevent accidentally invoking the worker with unlimited
  -- claims, even from a privileged server process.
  BEGIN
    PERFORM * FROM public.claim_openwa_deferred_events(0);
    RAISE EXCEPTION 'Invalid worker batch unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
  RAISE NOTICE 'OpenWA deferred identity/ACK ledger smoke passed';
END $deferred$;

ROLLBACK;
