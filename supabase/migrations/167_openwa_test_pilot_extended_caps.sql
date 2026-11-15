-- OW-13 / SOF-66: Expand the TEST-only, admin-editable OpenWA Pilot
-- session/workload ceiling to 100/hour and 1000/day.
--
-- Additive migration: retain all rows, NULL-inherits-shared semantics,
-- account/connection isolation, hashed allowlists, consent, pause, circuit,
-- first-touch protection, warmup and pacing. Do NOT alter applied migration 165.
-- Does NOT update any live guardrail values or grant/activate any recipients.
-- Shared 149 schema already permits 100/hour and 1000/day; only pilot
-- workload-specific checks need to be replaced.

ALTER TABLE public.whatsapp_connection_guardrails
  DROP CONSTRAINT IF EXISTS whatsapp_connection_guardrails_pilot_agent_hourly_cap_check,
  DROP CONSTRAINT IF EXISTS whatsapp_connection_guardrails_pilot_agent_daily_cap_check,
  DROP CONSTRAINT IF EXISTS whatsapp_connection_guardrails_pilot_manual_hourly_cap_check,
  DROP CONSTRAINT IF EXISTS whatsapp_connection_guardrails_pilot_manual_daily_cap_check,
  ADD CONSTRAINT whatsapp_connection_guardrails_pilot_agent_hourly_cap_check
    CHECK (pilot_agent_hourly_cap BETWEEN 1 AND 100),
  ADD CONSTRAINT whatsapp_connection_guardrails_pilot_agent_daily_cap_check
    CHECK (pilot_agent_daily_cap BETWEEN 1 AND 1000),
  ADD CONSTRAINT whatsapp_connection_guardrails_pilot_manual_hourly_cap_check
    CHECK (pilot_manual_hourly_cap BETWEEN 1 AND 100),
  ADD CONSTRAINT whatsapp_connection_guardrails_pilot_manual_daily_cap_check
    CHECK (pilot_manual_daily_cap BETWEEN 1 AND 1000);

COMMENT ON COLUMN public.whatsapp_connection_guardrails.pilot_agent_hourly_cap IS
  'TEST Pilot per-agent hourly maximum 100; effective cap is min(shared session, agent). Requires admin save while paused; does not bypass admission.';
COMMENT ON COLUMN public.whatsapp_connection_guardrails.pilot_agent_daily_cap IS
  'TEST Pilot per-agent daily maximum 1000; effective cap is min(shared session, agent). Does not change first-touch, consent or paced sends.';
COMMENT ON COLUMN public.whatsapp_connection_guardrails.pilot_manual_hourly_cap IS
  'TEST Pilot per-manual hourly maximum 100; effective cap is min(shared session, manual).';
COMMENT ON COLUMN public.whatsapp_connection_guardrails.pilot_manual_daily_cap IS
  'TEST Pilot per-manual daily maximum 1000; effective cap is min(shared session, manual).';
