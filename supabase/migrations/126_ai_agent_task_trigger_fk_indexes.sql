-- ============================================================
-- 126_ai_agent_task_trigger_fk_indexes.sql
-- Phase 13 performance hardening for foreign-key maintenance/lookups.
-- Added from TEST Supabase Performance Advisor findings after migrations 124-125.
-- ============================================================

create index if not exists ai_agent_task_triggers_agent_idx
  on public.ai_agent_task_triggers(agent_id);

create index if not exists ai_agent_task_trigger_firings_account_idx
  on public.ai_agent_task_trigger_firings(account_id);

create index if not exists ai_agent_task_trigger_firings_business_event_idx
  on public.ai_agent_task_trigger_firings(business_event_id)
  where business_event_id is not null;

create index if not exists ai_agent_task_trigger_firings_task_idx
  on public.ai_agent_task_trigger_firings(task_id)
  where task_id is not null;
