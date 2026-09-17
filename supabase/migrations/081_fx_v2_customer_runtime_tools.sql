-- ============================================================
-- 081_fx_v2_customer_runtime_tools.sql
-- Phase 4 — customer AI/runtime tools use FX V2.
--
-- exchange_rates.record_trade_request v2 requires the exact immutable
-- rate_version_id returned by exchange_rates.get_current. This prevents a
-- customer from confirming one quote and silently submitting against a newer
-- price. The executor creates exchange_trade_requests directly through the
-- Phase 2 RPC; it no longer creates a generic customer_intent.
--
-- Existing grants are upgraded in place, matching the precedent used for
-- coverage.propose_offer in migration 066. The grant remains `propose`:
-- creating a pending_admin customer request is not rate publication and is
-- not settlement completion.
-- ============================================================

update public.ai_agent_tool_grants
   set tool_version = 2
 where tool_key = 'exchange_rates.record_trade_request'
   and tool_version = 1;

comment on table public.ai_agent_tool_grants is
  'Frozen per-revision tool grants. Security-compatible contract upgrades may migrate an existing tool version when the new contract narrows model authority or adds replay/quote safety; FX trade requests v2 require the quoted immutable rate version.';
