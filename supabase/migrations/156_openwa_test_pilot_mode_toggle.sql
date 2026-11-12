-- TEST-only, admin-controlled per-session Pilot mode. Defaults to protected.
-- Production ignores this override and still follows OPENWA_PILOT_MODE.
ALTER TABLE public.whatsapp_connection_guardrails
  ADD COLUMN pilot_enabled boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.whatsapp_connection_guardrails.pilot_enabled IS
  'TEST OpenWA Pilot admission; default enabled. Only the TEST admin API may change this setting.';

CREATE TABLE public.whatsapp_openwa_pilot_mode_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  changed_by uuid NOT NULL REFERENCES auth.users(id),
  pilot_enabled boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_openwa_pilot_mode_events_scope_idx
  ON public.whatsapp_openwa_pilot_mode_events (account_id, connection_id, created_at DESC);
ALTER TABLE public.whatsapp_openwa_pilot_mode_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_openwa_pilot_mode_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.whatsapp_openwa_pilot_mode_events TO service_role;

-- The caller is an authenticated TEST admin route. Recheck tenant/provider,
-- session readiness, unsettled sends and duplicate identities in this same
-- transaction. Never dispatch or retry WhatsApp from this function.
CREATE FUNCTION public.set_openwa_test_pilot_mode(
  p_account_id uuid, p_connection_id uuid, p_actor uuid,
  p_pilot_enabled boolean, p_confirm_normal_sending boolean DEFAULT false,
  p_ack_duplicate_sessions boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $fn$
DECLARE
  v_connection public.whatsapp_connections%rowtype;
  v_duplicates integer := 0;
  v_pending integer := 0;
  v_affected integer;
BEGIN
  IF p_account_id IS NULL OR p_connection_id IS NULL OR p_actor IS NULL
    OR p_pilot_enabled IS NULL THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'invalid_request');
  END IF;
  SELECT * INTO v_connection
    FROM public.whatsapp_connections
    WHERE id = p_connection_id AND account_id = p_account_id
      AND provider = 'openwa' AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'connection_scope_mismatch');
  END IF;
  IF NOT p_pilot_enabled THEN
    IF NOT p_confirm_normal_sending OR v_connection.session_id IS NULL
      OR v_connection.status NOT IN ('ready', 'connected') THEN
      RETURN jsonb_build_object('updated', false, 'reason', 'not_ready_or_unconfirmed');
    END IF;
    SELECT count(*) INTO v_pending FROM public.messages
      WHERE provider = 'openwa' AND connection_id = p_connection_id
        AND status = 'sending' AND provider_message_id IS NULL;
    IF v_pending <> 0 THEN
      RETURN jsonb_build_object('updated', false, 'reason', 'unsettled_outbound');
    END IF;
    IF v_connection.phone_identity IS NOT NULL THEN
      SELECT count(*) INTO v_duplicates FROM public.whatsapp_connections
        WHERE account_id = p_account_id AND provider = 'openwa'
          AND phone_identity = v_connection.phone_identity
          AND archived_at IS NULL AND status IN ('ready','connected');
    END IF;
    IF v_duplicates > 1 AND NOT p_ack_duplicate_sessions THEN
      RETURN jsonb_build_object('updated', false, 'reason', 'duplicate_sessions');
    END IF;
  END IF;

  -- Disabling Pilot resumes normal sending with OW-10 default limits, NOT
  -- unlimited sending. Enabling Pilot pauses and restores strict pilot limits.
  -- Preserve circuit_open_until, which remains an independent safety stop.
  INSERT INTO public.whatsapp_connection_guardrails
    (account_id, connection_id, pilot_enabled, manual_paused,
     hourly_cap, daily_cap, first_touch_daily_cap, minimum_interval_ms, jitter_ms,
     warmup_until, warmup_hourly_cap, warmup_daily_cap, failure_min_attempts)
  VALUES (p_account_id, p_connection_id, p_pilot_enabled, p_pilot_enabled,
    CASE WHEN p_pilot_enabled THEN 3 ELSE 60 END,
    CASE WHEN p_pilot_enabled THEN 10 ELSE 500 END,
    CASE WHEN p_pilot_enabled THEN 1 ELSE 100 END,
    CASE WHEN p_pilot_enabled THEN 15000 ELSE 1500 END,
    CASE WHEN p_pilot_enabled THEN 3000 ELSE 1000 END,
    CASE WHEN p_pilot_enabled THEN now() + interval '7 days' ELSE NULL END,
    CASE WHEN p_pilot_enabled THEN 3 ELSE 20 END,
    CASE WHEN p_pilot_enabled THEN 10 ELSE 100 END,
    CASE WHEN p_pilot_enabled THEN 2 ELSE 10 END)
  ON CONFLICT (connection_id) DO UPDATE SET
    pilot_enabled = EXCLUDED.pilot_enabled,
    manual_paused = EXCLUDED.manual_paused,
    hourly_cap = EXCLUDED.hourly_cap,
    daily_cap = EXCLUDED.daily_cap,
    first_touch_daily_cap = EXCLUDED.first_touch_daily_cap,
    minimum_interval_ms = EXCLUDED.minimum_interval_ms,
    jitter_ms = EXCLUDED.jitter_ms,
    warmup_until = EXCLUDED.warmup_until,
    warmup_hourly_cap = EXCLUDED.warmup_hourly_cap,
    warmup_daily_cap = EXCLUDED.warmup_daily_cap,
    failure_min_attempts = EXCLUDED.failure_min_attempts,
    updated_at = now()
  WHERE public.whatsapp_connection_guardrails.account_id = EXCLUDED.account_id;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected <> 1 THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'guardrail_scope_mismatch');
  END IF;
  UPDATE public.whatsapp_openwa_pilot_allowlist SET active = false
    WHERE account_id = p_account_id AND connection_id = p_connection_id AND active;
  INSERT INTO public.whatsapp_guardrail_events
    (account_id, connection_id, workload, decision, reason)
    VALUES (p_account_id, p_connection_id, 'manual',
      CASE WHEN p_pilot_enabled THEN 'paused' ELSE 'resumed' END,
      CASE WHEN p_pilot_enabled THEN 'test_pilot_enabled' ELSE 'test_pilot_disabled' END);
  INSERT INTO public.whatsapp_openwa_pilot_mode_events
    (account_id, connection_id, changed_by, pilot_enabled)
    VALUES (p_account_id, p_connection_id, p_actor, p_pilot_enabled);
  RETURN jsonb_build_object('updated', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_openwa_test_pilot_mode(uuid,uuid,uuid,boolean,boolean,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_openwa_test_pilot_mode(uuid,uuid,uuid,boolean,boolean,boolean)
  TO service_role;
