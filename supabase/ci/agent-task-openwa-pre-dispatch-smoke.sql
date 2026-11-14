-- SOF-63: service-only, fail-closed pre-dispatch denial terminal transition.
-- Ephemeral CI DB, no real WhatsApp transport. No data mutations persist.
BEGIN;
DO $$
DECLARE
  v_fn regprocedure;
  v_body text;
BEGIN
  v_fn := to_regprocedure(
    'public.finalize_agent_task_outbound_pre_dispatch_denial(uuid,uuid,text,text)'
  );
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'SOF63_PRE_DISPATCH_RPC_MISSING';
  END IF;
  IF has_function_privilege('anon',v_fn,'EXECUTE')
     OR has_function_privilege('authenticated',v_fn,'EXECUTE') THEN
    RAISE EXCEPTION 'SOF63_PRE_DISPATCH_PRIVILEGE_LEAK';
  END IF;
  IF NOT has_function_privilege('service_role',v_fn,'EXECUTE') THEN
    RAISE EXCEPTION 'SOF63_PRE_DISPATCH_SERVICE_ROLE_REQUIRED';
  END IF;
  v_body:=pg_get_functiondef(v_fn);
  IF position('provider=''openwa''' in v_body)=0
     OR position('status=''sending''' in v_body)=0
     OR position('local_message_id IS NULL' in v_body)=0
     OR position('whatsapp_message_id IS NULL' in v_body)=0
     OR position('claimed_by=p_worker_id' in v_body)=0 THEN
    RAISE EXCEPTION 'SOF63_PRE_DISPATCH_PROOF_BOUNDARY_MISSING';
  END IF;
  IF public.finalize_agent_task_outbound_pre_dispatch_denial(
    gen_random_uuid(),gen_random_uuid(),'sof63-test','OPENWA_PRE_DISPATCH_DENIED'
  ) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'SOF63_PRE_DISPATCH_UNKNOWN_RESERVATION_NOT_DENIED';
  END IF;
  BEGIN
    PERFORM public.finalize_agent_task_outbound_pre_dispatch_denial(
      gen_random_uuid(),gen_random_uuid(),'sof63-test','invalid input'
    );
    RAISE EXCEPTION 'SOF63_PRE_DISPATCH_UNSAFE_REASON_ACCEPTED';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT LIKE '%AGENT_PRE_DISPATCH_DENIAL_INPUT_INVALID%' THEN
        RAISE;
      END IF;
  END;
END $$;
ROLLBACK;
