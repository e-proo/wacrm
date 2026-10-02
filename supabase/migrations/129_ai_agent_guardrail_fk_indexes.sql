-- ============================================================
-- 129_ai_agent_guardrail_fk_indexes.sql
-- Phase 14: cover only foreign keys introduced by migrations 127-128.
-- ============================================================

create index if not exists ai_provider_model_cost_rates_created_by_idx
  on public.ai_provider_model_cost_rates(created_by)
  where created_by is not null;

create index if not exists ai_agent_scope_controls_created_by_idx
  on public.ai_agent_scope_controls(created_by)
  where created_by is not null;

create index if not exists ai_agent_circuit_breakers_created_by_idx
  on public.ai_agent_circuit_breakers(created_by)
  where created_by is not null;
