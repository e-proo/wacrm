-- TEST-only safe mode disable while transport remains PAUSED.
-- Never sends, retries, reconciles or marks an uncertain outbound resolved.
CREATE FUNCTION public.set_openwa_test_pilot_paused_mode(
 p_account_id uuid, p_connection_id uuid, p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $fn$
DECLARE v_connection public.whatsapp_connections%rowtype;
        v_guard public.whatsapp_connection_guardrails%rowtype;
        v_updated integer;
BEGIN
 IF p_account_id IS NULL OR p_connection_id IS NULL OR p_actor IS NULL THEN
   RETURN jsonb_build_object('updated',false,'reason','invalid_request');
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(
   pg_catalog.hashtext(p_account_id::text||':'||p_connection_id::text)
 );
 SELECT * INTO v_connection FROM public.whatsapp_connections
 WHERE account_id=p_account_id AND id=p_connection_id
   AND provider='openwa' AND archived_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN
   RETURN jsonb_build_object('updated',false,'reason','connection_scope_mismatch');
 END IF;
 SELECT * INTO v_guard FROM public.whatsapp_connection_guardrails
 WHERE account_id=p_account_id AND connection_id=p_connection_id FOR UPDATE;
 IF NOT FOUND OR v_guard.manual_paused IS DISTINCT FROM true THEN
   RETURN jsonb_build_object('updated',false,'reason','stop_required');
 END IF;
 IF v_guard.pilot_enabled IS DISTINCT FROM true THEN
   RETURN jsonb_build_object('updated',true,'already_disabled',true);
 END IF;
 -- Preserve manual pause and circuit breaker. Normalize values to the ordinary
 -- non-Pilot limits; these stay bounded by OW-10 checks even in TEST.
 UPDATE public.whatsapp_connection_guardrails SET
   pilot_enabled=false,manual_paused=true,
   hourly_cap=60,daily_cap=500,first_touch_daily_cap=100,
   minimum_interval_ms=1500,jitter_ms=1000,
   warmup_until=NULL,warmup_hourly_cap=20,warmup_daily_cap=100,
   failure_min_attempts=10,updated_at=now()
 WHERE account_id=p_account_id AND connection_id=p_connection_id
   AND pilot_enabled=true AND manual_paused=true;
 GET DIAGNOSTICS v_updated=ROW_COUNT;
 IF v_updated<>1 THEN RETURN jsonb_build_object('updated',false,'reason','state_changed'); END IF;

 UPDATE public.whatsapp_openwa_pilot_allowlist SET active=false
 WHERE account_id=p_account_id AND connection_id=p_connection_id AND active=true;
 INSERT INTO public.whatsapp_guardrail_events
  (account_id,connection_id,workload,decision,reason)
 VALUES (p_account_id,p_connection_id,'manual','paused','test_pilot_disabled_sends_remain_paused');
 INSERT INTO public.whatsapp_openwa_pilot_mode_events
  (account_id,connection_id,changed_by,pilot_enabled)
 VALUES (p_account_id,p_connection_id,p_actor,false);
 RETURN jsonb_build_object('updated',true,'sends_paused',true);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_openwa_test_pilot_paused_mode(uuid,uuid,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_openwa_test_pilot_paused_mode(uuid,uuid,uuid)
 TO service_role;
