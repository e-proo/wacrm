-- ============================================================
-- 120_ai_agent_outbound_delivery_gate.sql
-- Explicit fail-closed gate for live Agent Task outbound delivery.
--
-- The Agent Task Platform may be developed/verified while Meta Gate C/D is
-- externally blocked. No task worker may call WhatsApp transport unless this
-- account-scoped switch is explicitly enabled after channel validation.
-- ============================================================

alter table public.ai_runtime_policies
  add column if not exists outbound_task_delivery_enabled boolean not null default false;

comment on column public.ai_runtime_policies.outbound_task_delivery_enabled is
  'Explicit live transport gate for Agent Task outbound delivery. Default false; enable only after channel/Meta validation.';
