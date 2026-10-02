-- ============================================================
-- 138_ai_agent_function_surface_hardening.sql
-- Phase 16: harden remaining Agent-adjacent function surface without changing
-- authenticated admin workflows that authorize internally.
-- ============================================================

-- Trigger functions are not RPC application surfaces.
revoke all on function public.guard_ai_agent_kb_assignment_draft()
  from public,anon,authenticated;
grant execute on function public.guard_ai_agent_kb_assignment_draft()
  to service_role;

revoke all on function public.notify_customer_intent_forwarded()
  from public,anon,authenticated;
grant execute on function public.notify_customer_intent_forwarded()
  to service_role;

-- KB assignment replacement is an intentional authenticated admin RPC and
-- performs is_account_member(account,'admin') internally. Remove PUBLIC/anon.
revoke all on function public.replace_ai_agent_knowledge_base_assignments(
  uuid,uuid,jsonb,uuid
) from public,anon;
grant execute on function public.replace_ai_agent_knowledge_base_assignments(
  uuid,uuid,jsonb,uuid
) to authenticated,service_role;

-- Stable search_path for Agent/Intent timestamp trigger helpers.
alter function public.update_ai_agent_routes_updated_at()
  set search_path=pg_catalog,public;
alter function public.update_ai_agent_runs_updated_at()
  set search_path=pg_catalog,public;
alter function public.update_ai_agents_updated_at()
  set search_path=pg_catalog,public;
alter function public.update_ai_agent_templates_updated_at()
  set search_path=pg_catalog,public;
alter function public.update_ai_agent_budget_policies_updated_at()
  set search_path=pg_catalog,public;
alter function public.update_ai_agent_rate_limits_updated_at()
  set search_path=pg_catalog,public;
alter function public.update_customer_intents_updated_at()
  set search_path=pg_catalog,public;
