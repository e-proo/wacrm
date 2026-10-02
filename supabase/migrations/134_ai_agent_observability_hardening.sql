-- ============================================================
-- 134_ai_agent_observability_hardening.sql
-- Phase 15 advisor hardening: cover the run FK and make client denial
-- explicit while preserving service-role-only observability tables.
-- ============================================================

create index if not exists ai_agent_circuit_events_account_run_idx
  on public.ai_agent_circuit_events(account_id,run_id)
  where run_id is not null;

drop policy if exists ai_agent_business_outcome_links_client_deny
  on public.ai_agent_business_outcome_links;
create policy ai_agent_business_outcome_links_client_deny
  on public.ai_agent_business_outcome_links
  for all
  to anon,authenticated
  using (false)
  with check (false);

drop policy if exists ai_agent_circuit_events_client_deny
  on public.ai_agent_circuit_events;
create policy ai_agent_circuit_events_client_deny
  on public.ai_agent_circuit_events
  for all
  to anon,authenticated
  using (false)
  with check (false);
