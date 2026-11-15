-- OW-13 / SOF-66: TEST pilot multiple individually-approved recipients with
-- two bounded workload quota classes. Adds no open admission, no active grants,
-- no change to Production's existing reserve_openwa_guardrail_send behavior.
ALTER TABLE public.whatsapp_connection_guardrails
  ADD COLUMN pilot_agent_hourly_cap integer NULL
    CHECK (pilot_agent_hourly_cap BETWEEN 1 AND 10),
  ADD COLUMN pilot_agent_daily_cap integer NULL
    CHECK (pilot_agent_daily_cap BETWEEN 1 AND 30),
  ADD COLUMN pilot_manual_hourly_cap integer NULL
    CHECK (pilot_manual_hourly_cap BETWEEN 1 AND 10),
  ADD COLUMN pilot_manual_daily_cap integer NULL
    CHECK (pilot_manual_daily_cap BETWEEN 1 AND 30);

COMMENT ON COLUMN public.whatsapp_connection_guardrails.pilot_agent_daily_cap IS
  'TEST-only additional per-agent-workload cap; NULL inherits the shared connection daily cap. Never overrides shared account/channel anti-abuse gates.';
COMMENT ON COLUMN public.whatsapp_connection_guardrails.pilot_manual_daily_cap IS
  'TEST-only additional per-manual-workload cap; NULL inherits the shared connection daily cap.';

-- Invoker-only wrapper. App routes here ONLY for the pinned TEST project while
-- Pilot is enforced. Shared OW-10 guardrail reservation remains authoritative.
-- The SAME advisory lock used by that reservation serializes the workload cap
-- check and the subsequent shared-cap reservation in this transaction.
CREATE FUNCTION public.reserve_openwa_pilot_workload_send(
  p_account_id uuid, p_connection_id uuid,
  p_recipient_hash text, p_workload text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $func$
DECLARE
  v_guard public.whatsapp_connection_guardrails%rowtype;
  v_hour_limit integer;
  v_day_limit integer;
  v_hour_used bigint;
  v_day_used bigint;
BEGIN
  IF p_account_id IS NULL OR p_connection_id IS NULL OR
     p_workload NOT IN ('manual','agent','automation','broadcast','api') OR
     p_workload IS NULL THEN
    RETURN jsonb_build_object('allowed',false,'reason','invalid_request');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_account_id::text||':'||p_connection_id::text)
  );
  SELECT * INTO v_guard FROM public.whatsapp_connection_guardrails
    WHERE account_id=p_account_id AND connection_id=p_connection_id FOR UPDATE;
  IF NOT FOUND OR v_guard.pilot_enabled IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('allowed',false,'reason','pilot_guardrail_scope_missing');
  END IF;

  IF p_workload='agent' THEN
    v_hour_limit:=least(v_guard.hourly_cap,
      coalesce(v_guard.pilot_agent_hourly_cap,v_guard.hourly_cap));
    v_day_limit:=least(v_guard.daily_cap,
      coalesce(v_guard.pilot_agent_daily_cap,v_guard.daily_cap));
  ELSIF p_workload='manual' THEN
    v_hour_limit:=least(v_guard.hourly_cap,
      coalesce(v_guard.pilot_manual_hourly_cap,v_guard.hourly_cap));
    v_day_limit:=least(v_guard.daily_cap,
      coalesce(v_guard.pilot_manual_daily_cap,v_guard.daily_cap));
  END IF;

  IF v_hour_limit IS NOT NULL AND v_day_limit IS NOT NULL THEN
    SELECT count(*) INTO v_hour_used FROM public.whatsapp_guardrail_events
      WHERE account_id=p_account_id AND connection_id=p_connection_id
        AND workload=p_workload AND decision='reserved'
        AND created_at >= now()-interval '1 hour';
    SELECT count(*) INTO v_day_used FROM public.whatsapp_guardrail_events
      WHERE account_id=p_account_id AND connection_id=p_connection_id
        AND workload=p_workload AND decision='reserved'
        AND created_at >= now()-interval '24 hours';
    IF v_hour_used>=v_hour_limit OR v_day_used>=v_day_limit THEN
      INSERT INTO public.whatsapp_guardrail_events
        (account_id,connection_id,recipient_hash,workload,decision,reason)
      VALUES (p_account_id,p_connection_id,p_recipient_hash,p_workload,'blocked',
        CASE WHEN v_hour_used>=v_hour_limit THEN 'pilot_workload_hourly_cap'
          ELSE 'pilot_workload_daily_cap' END);
      RETURN jsonb_build_object('allowed',false,
        'reason',CASE WHEN v_hour_used>=v_hour_limit
          THEN 'pilot_workload_hourly_cap' ELSE 'pilot_workload_daily_cap' END);
    END IF;
  END IF;

  -- This existing RPC checks readiness, pause, circuit breaker,
  -- global hour/day caps, first-touch caps and pacing, under the same lock.
  RETURN public.reserve_openwa_guardrail_send(
    p_account_id,p_connection_id,p_recipient_hash,p_workload
  );
END
$func$;

REVOKE ALL ON FUNCTION public.reserve_openwa_pilot_workload_send(uuid,uuid,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_openwa_pilot_workload_send(uuid,uuid,text,text)
  TO service_role;
