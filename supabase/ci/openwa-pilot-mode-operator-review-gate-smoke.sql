-- Read-only verification that mode switching shares audited review semantics.
BEGIN;
DO $$
DECLARE v_source text; v_result jsonb;
BEGIN
 SELECT pg_get_functiondef(
   'public.set_openwa_test_pilot_mode(uuid,uuid,uuid,boolean,boolean,boolean)'::regprocedure
 ) INTO v_source;
 IF position('openwa_outbound_operator_reviews' IN v_source)=0
    OR position('r.message_id IS NULL' IN v_source)=0
    OR position('r.account_id = p_account_id' IN v_source)=0
    OR position('r.connection_id = p_connection_id' IN v_source)=0
    OR position('conv.account_id = p_account_id' IN v_source)=0
    OR position('pg_advisory_xact_lock' IN v_source)=0
    OR position('v_pending <> 0' IN v_source)=0
    OR position('p_confirm_normal_sending' IN v_source)=0 THEN
   RAISE EXCEPTION 'Pilot resume function must deny unreviewed sends and retain confirmation/scoping';
 END IF;
 IF has_function_privilege('anon',
      'public.set_openwa_test_pilot_mode(uuid,uuid,uuid,boolean,boolean,boolean)','EXECUTE')
    OR has_function_privilege('authenticated',
      'public.set_openwa_test_pilot_mode(uuid,uuid,uuid,boolean,boolean,boolean)','EXECUTE')
    OR NOT has_function_privilege('service_role',
      'public.set_openwa_test_pilot_mode(uuid,uuid,uuid,boolean,boolean,boolean)','EXECUTE')
 THEN RAISE EXCEPTION 'Pilot review-aware resume privilege violation'; END IF;
 SELECT public.set_openwa_test_pilot_mode(
   '11111111-1111-4111-8111-111111111111',
   '22222222-2222-4222-8222-222222222222',
   '33333333-3333-4333-8333-333333333333',
   false,true,false
 ) INTO v_result;
 IF v_result->>'updated'<>'false' OR v_result->>'reason'<>'connection_scope_mismatch'
 THEN RAISE EXCEPTION 'Unknown tenant unexpectedly changed OpenWA mode'; END IF;
END $$;
ROLLBACK;
