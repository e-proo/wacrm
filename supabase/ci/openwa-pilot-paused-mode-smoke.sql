-- Verify TEST paused mode switch without touching any real session or sends.
BEGIN;
DO $check$
DECLARE v_out jsonb; v_fn text;
BEGIN
 IF to_regprocedure('public.set_openwa_test_pilot_paused_mode(uuid,uuid,uuid)') IS NULL
    OR has_function_privilege('anon','public.set_openwa_test_pilot_paused_mode(uuid,uuid,uuid)','EXECUTE')
    OR has_function_privilege('authenticated','public.set_openwa_test_pilot_paused_mode(uuid,uuid,uuid)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.set_openwa_test_pilot_paused_mode(uuid,uuid,uuid)','EXECUTE')
 THEN RAISE EXCEPTION 'Safe Pilot mode RPC privilege violation'; END IF;
 SELECT pg_get_functiondef('public.set_openwa_test_pilot_paused_mode(uuid,uuid,uuid)'::regprocedure) INTO v_fn;
 IF position('manual_paused=true' IN v_fn)=0
   OR position('pilot_enabled=false' IN v_fn)=0
   OR position('pg_advisory_xact_lock' IN v_fn)=0
   OR position('account_id=p_account_id' IN v_fn)=0
   OR position('connection_id=p_connection_id' IN v_fn)=0
 THEN RAISE EXCEPTION 'Safe Pilot mode function missing pause or account/connection fencing'; END IF;
 SELECT public.set_openwa_test_pilot_paused_mode(
   '11111111-1111-4111-8111-111111111111',
   '22222222-2222-4222-8222-222222222222',
   '33333333-3333-4333-8333-333333333333') INTO v_out;
 IF v_out->>'updated'<>'false' OR v_out->>'reason'<>'connection_scope_mismatch'
 THEN RAISE EXCEPTION 'Unknown scope switched Pilot mode'; END IF;
END $check$;
ROLLBACK;
