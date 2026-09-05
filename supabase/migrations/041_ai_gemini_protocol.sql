-- ============================================================
-- 041_ai_gemini_protocol.sql — allow the Gemini Native protocol
--
-- Additive constraint widening for Phase 04. `ai_provider_connections.protocol`
-- gains 'gemini_native'. Keep in lockstep with ProviderProtocol in
-- src/lib/ai/providers/contract.ts and the registry.
--
-- The previous CHECK is replaced inside one transaction; existing rows
-- are unaffected (they only hold 'openai'/'anthropic'). No data loss.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

alter table public.ai_provider_connections
  drop constraint if exists ai_provider_connections_protocol_check;

alter table public.ai_provider_connections
  add constraint ai_provider_connections_protocol_check
  check (protocol in ('openai', 'anthropic', 'gemini_native'));
