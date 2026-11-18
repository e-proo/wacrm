-- All-session review summaries: service only, scoped, include zero-issue sessions.
BEGIN;
DO $$
DECLARE v_rows jsonb; v_function text;
BEGIN
  IF to_regprocedure('public.list_openwa_outbound_review_counts(uuid)') IS NULL THEN
    RAISE EXCEPTION 'OpenWA all-session review list RPC missing';
  END IF;
  IF has_function_privilege('anon','public.list_openwa_outbound_review_counts(uuid)','EXECUTE')
     OR has_function_privilege('authenticated','public.list_openwa_outbound_review_counts(uuid)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.list_openwa_outbound_review_counts(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'OpenWA all-session review list privilege regression';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid='public.list_openwa_outbound_review_counts(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'OpenWA all-session summary must use SECURITY INVOKER';
  END IF;
  SELECT pg_get_functiondef('public.list_openwa_outbound_review_counts(uuid)'::regprocedure) INTO v_function;
  IF position('c.account_id=p_account_id' IN v_function)=0
    OR position('v.account_id=p_account_id' IN v_function)=0
    OR position('r.account_id=p_account_id' IN v_function)=0
    OR position('m.connection_id=c.id' IN v_function)=0
    OR position('c.provider=' IN v_function)=0
    OR position('m.provider=' IN v_function)=0
    OR position('c.archived_at IS NULL' IN v_function)=0
    OR position('LEFT JOIN LATERAL' IN v_function)=0 THEN
      RAISE EXCEPTION 'OpenWA all-session summary missing account, provider, or future session boundary';
  END IF;
  SELECT public.list_openwa_outbound_review_counts(
    '11111111-1111-4111-8111-111111111111') INTO v_rows;
  IF v_rows <> '[]'::jsonb THEN
    RAISE EXCEPTION 'OpenWA all-session summary leaked an unknown account';
  END IF;
END $$;
ROLLBACK;
