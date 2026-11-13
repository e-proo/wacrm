-- SOF-60: keep the provider selected by the domain message policy
-- identical to the provider atomically frozen by SOF-59 reservation.
-- A mismatch raises an exception, rolling back ANY reservation side effects.
-- Older 12-argument reserve_bound... RPC remains supported for legacy V1.
CREATE OR REPLACE FUNCTION public.reserve_expected_provider_agent_task_outbound_message(
  p_run_id uuid,
  p_policy_key text,
  p_policy_version integer,
  p_message_kind text,
  p_candidate_text text,
  p_template_name text,
  p_template_language text,
  p_template_params jsonb,
  p_max_followups integer,
  p_minimum_interval_minutes integer,
  p_maximum_interval_minutes integer,
  p_stop_on_reply boolean,
  p_expected_provider text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_expected_provider NOT IN ('meta_cloud','openwa')
     OR p_expected_provider IS NULL THEN
    RAISE EXCEPTION 'AGENT_TASK_EXPECTED_PROVIDER_INVALID';
  END IF;
  v_result := public.reserve_bound_agent_task_outbound_message(
    p_run_id,p_policy_key,p_policy_version,p_message_kind,p_candidate_text,
    p_template_name,p_template_language,p_template_params,
    p_max_followups,p_minimum_interval_minutes,p_maximum_interval_minutes,
    p_stop_on_reply
  );
  IF (v_result->>'reserved')::boolean IS TRUE
     AND v_result->>'provider' IS DISTINCT FROM p_expected_provider THEN
    RAISE EXCEPTION 'AGENT_TASK_PROVIDER_CHANGED';
  END IF;
  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.reserve_expected_provider_agent_task_outbound_message(
  uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_expected_provider_agent_task_outbound_message(
  uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean,text
) TO service_role;

COMMENT ON FUNCTION public.reserve_expected_provider_agent_task_outbound_message(
  uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean,text
) IS 'SOF-60: transactionally ensure the deterministic provider-aware message policy matches the frozen outbound transport.';
