-- Read-only smoke; no real transport and no persistent changes.
BEGIN;
DO $$
DECLARE v_q jsonb; v_result jsonb; v_fn text;
BEGIN
  IF to_regprocedure('public.get_openwa_outbound_review_queue(uuid,uuid)') IS NULL
    OR to_regprocedure('public.acknowledge_openwa_ambiguous_outbound(uuid,uuid,uuid,uuid,text,text,boolean)') IS NULL
  THEN RAISE EXCEPTION 'Operator ambiguous-outbound review RPC missing'; END IF;
  IF has_function_privilege('anon','public.get_openwa_outbound_review_queue(uuid,uuid)','EXECUTE')
     OR has_function_privilege('authenticated','public.get_openwa_outbound_review_queue(uuid,uuid)','EXECUTE')
     OR has_function_privilege('anon','public.acknowledge_openwa_ambiguous_outbound(uuid,uuid,uuid,uuid,text,text,boolean)','EXECUTE')
     OR has_function_privilege('authenticated','public.acknowledge_openwa_ambiguous_outbound(uuid,uuid,uuid,uuid,text,text,boolean)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.acknowledge_openwa_ambiguous_outbound(uuid,uuid,uuid,uuid,text,text,boolean)','EXECUTE')
  THEN RAISE EXCEPTION 'Operator review server-only privilege boundary failed'; END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid='public.acknowledge_openwa_ambiguous_outbound(uuid,uuid,uuid,uuid,text,text,boolean)'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid='public.get_openwa_outbound_review_queue(uuid,uuid)'::regprocedure)
  THEN RAISE EXCEPTION 'Operator review must be SECURITY INVOKER'; END IF;

  SELECT pg_get_functiondef('public.acknowledge_openwa_ambiguous_outbound(uuid,uuid,uuid,uuid,text,text,boolean)'::regprocedure) INTO v_fn;
  IF position('manual_paused' IN v_fn)=0
    OR position('outbound_idempotency_key IS NOT NULL' IN v_fn)=0
    OR position('p_confirm_no_resend' IN v_fn)=0
    OR position('conv.account_id=p_account_id' IN v_fn)=0
    OR position('FOR UPDATE OF m' IN v_fn)=0
  THEN RAISE EXCEPTION 'Review RPC missing scope, pause, or idempotency fencing'; END IF;

  SELECT public.get_openwa_outbound_review_queue(
    '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222') INTO v_q;
  IF v_q IS NOT NULL THEN RAISE EXCEPTION 'Unknown scoped connection exposed message queue'; END IF;

  SELECT public.acknowledge_openwa_ambiguous_outbound(
    '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444',
    'still_uncertain','Only a synthetic scoped row test',true
  ) INTO v_result;
  IF v_result->>'updated' <> 'false' OR v_result->>'reason' <> 'connection_scope_mismatch'
  THEN RAISE EXCEPTION 'Unknown scope unexpectedly reviewed an outbound'; END IF;
END $$;
ROLLBACK;
