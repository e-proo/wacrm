-- Adjustable TEST OpenWA Pilot caps. Production's normal OW-10 constraints
-- remain in effect for connections with pilot_enabled=false.
-- Does not change any existing guardrail values, approvals or active sends.
ALTER TABLE public.whatsapp_connection_guardrails
 DROP CONSTRAINT whatsapp_connection_guardrails_hourly_cap_check,
 DROP CONSTRAINT whatsapp_connection_guardrails_daily_cap_check,
 DROP CONSTRAINT whatsapp_connection_guardrails_first_touch_daily_cap_check,
 DROP CONSTRAINT whatsapp_connection_guardrails_warmup_hourly_cap_check,
 DROP CONSTRAINT whatsapp_connection_guardrails_warmup_daily_cap_check,
 DROP CONSTRAINT whatsapp_connection_guardrails_pilot_agent_hourly_cap_check,
 DROP CONSTRAINT whatsapp_connection_guardrails_pilot_agent_daily_cap_check,
 DROP CONSTRAINT whatsapp_connection_guardrails_pilot_manual_hourly_cap_check,
 DROP CONSTRAINT whatsapp_connection_guardrails_pilot_manual_daily_cap_check,
 ADD CONSTRAINT whatsapp_connection_guardrails_hourly_cap_check
  CHECK (hourly_cap>=1 AND (pilot_enabled IS TRUE OR hourly_cap<=10000)),
 ADD CONSTRAINT whatsapp_connection_guardrails_daily_cap_check
  CHECK (daily_cap>=1 AND (pilot_enabled IS TRUE OR daily_cap<=100000)),
 ADD CONSTRAINT whatsapp_connection_guardrails_first_touch_daily_cap_check
  CHECK (first_touch_daily_cap>=0 AND (pilot_enabled IS TRUE OR first_touch_daily_cap<=100000)),
 ADD CONSTRAINT whatsapp_connection_guardrails_warmup_hourly_cap_check
  CHECK (warmup_hourly_cap>=1 AND (pilot_enabled IS TRUE OR warmup_hourly_cap<=10000)),
 ADD CONSTRAINT whatsapp_connection_guardrails_warmup_daily_cap_check
  CHECK (warmup_daily_cap>=1 AND (pilot_enabled IS TRUE OR warmup_daily_cap<=100000)),
 ADD CONSTRAINT whatsapp_connection_guardrails_pilot_agent_hourly_cap_check CHECK (pilot_agent_hourly_cap>=1),
 ADD CONSTRAINT whatsapp_connection_guardrails_pilot_agent_daily_cap_check CHECK (pilot_agent_daily_cap>=1),
 ADD CONSTRAINT whatsapp_connection_guardrails_pilot_manual_hourly_cap_check CHECK (pilot_manual_hourly_cap>=1),
 ADD CONSTRAINT whatsapp_connection_guardrails_pilot_manual_daily_cap_check CHECK (pilot_manual_daily_cap>=1);

-- Service-only read: full 24h ledger, not truncated by PostgREST row limits.
-- No recipient identifiers, hashes, phone numbers or message contents returned.
CREATE OR REPLACE FUNCTION public.get_openwa_test_guardrail_usage(
 p_account_id uuid, p_connection_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.whatsapp_connections
  WHERE account_id=p_account_id AND id=p_connection_id
    AND provider='openwa' AND archived_at IS NULL) THEN RETURN NULL; END IF;
 WITH scoped AS (
  SELECT workload,decision,reason,recipient_hash,created_at
  FROM public.whatsapp_guardrail_events
  WHERE account_id=p_account_id AND connection_id=p_connection_id
    AND created_at>=now()-interval '24 hours'
 ),
 totals AS (
  SELECT count(*) FILTER(WHERE decision='reserved' AND created_at>=now()-interval '1 hour') AS hourly_reserved,
    count(*) FILTER(WHERE decision='reserved') AS daily_reserved,
    count(DISTINCT recipient_hash) FILTER(WHERE decision='reserved') AS distinct_recipients_daily
  FROM scoped
 ),
 workloads AS (
  SELECT workload,
    count(*) FILTER(WHERE decision='reserved' AND created_at>=now()-interval '1 hour') AS hourly_reserved,
    count(*) FILTER(WHERE decision='reserved') AS daily_reserved
  FROM scoped GROUP BY workload
 )
 SELECT jsonb_build_object(
   'hourly_reserved',totals.hourly_reserved,
   'daily_reserved',totals.daily_reserved,
   'distinct_recipients_daily',totals.distinct_recipients_daily,
   'workloads',coalesce((SELECT jsonb_object_agg(workload,jsonb_build_object(
     'hourly_reserved',hourly_reserved,'daily_reserved',daily_reserved)) FROM workloads),'{}'::jsonb),
   'last_blocked',(SELECT jsonb_build_object('reason',reason,'workload',workload,
     'created_at',created_at) FROM scoped WHERE decision='blocked'
     ORDER BY created_at DESC LIMIT 1)
 ) INTO result FROM totals;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.get_openwa_test_guardrail_usage(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_openwa_test_guardrail_usage(uuid,uuid) TO service_role;
