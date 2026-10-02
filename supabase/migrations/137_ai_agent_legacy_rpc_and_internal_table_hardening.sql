-- ============================================================
-- 137_ai_agent_legacy_rpc_and_internal_table_hardening.sql
-- Phase 16: close legacy mutation RPCs that are no longer part of the
-- current application path, keep authenticated Agent publish intentionally
-- available with its internal admin-membership check, and make service-only
-- internal table denial explicit for the security advisor.
-- ============================================================

-- Legacy Change Request create path. Current runtime uses create_change_request_v3.
revoke all on function public.create_change_request(
  uuid,text,uuid,text,jsonb,bigint,text,text,uuid
) from public,anon,authenticated;
grant execute on function public.create_change_request(
  uuid,text,uuid,text,jsonb,bigint,text,text,uuid
) to service_role;

-- Legacy Change Request approval path. Current application uses the v2
-- dashboard / trusted-admin approval RPCs through server-owned services.
revoke all on function public.approve_change_request(
  uuid,uuid,text,uuid
) from public,anon,authenticated;
grant execute on function public.approve_change_request(
  uuid,uuid,text,uuid
) to service_role;

-- Legacy direct intent matcher. Current Intents decisions are executed through
-- the typed Change Request executor and account-scoped table update.
revoke all on function public.match_customer_intent(
  uuid,uuid,uuid
) from public,anon,authenticated;
grant execute on function public.match_customer_intent(
  uuid,uuid,uuid
) to service_role;

-- Atomic Agent publish is an intentional authenticated RPC. It performs its
-- own is_account_member(account,'admin') check. Anonymous execution is never
-- valid.
revoke all on function public.publish_ai_agent_revision_atomic(
  uuid,uuid,uuid,bigint,uuid
) from public,anon;
grant execute on function public.publish_ai_agent_revision_atomic(
  uuid,uuid,uuid,bigint,uuid
) to authenticated,service_role;

-- Explicit client-deny policies for service-role-only internal tables.
drop policy if exists ai_agent_task_triggers_client_deny
  on public.ai_agent_task_triggers;
create policy ai_agent_task_triggers_client_deny
  on public.ai_agent_task_triggers
  for all
  to anon,authenticated
  using (false)
  with check (false);

drop policy if exists ai_agent_task_trigger_firings_client_deny
  on public.ai_agent_task_trigger_firings;
create policy ai_agent_task_trigger_firings_client_deny
  on public.ai_agent_task_trigger_firings
  for all
  to anon,authenticated
  using (false)
  with check (false);

drop policy if exists ai_runtime_budget_reservations_client_deny
  on public.ai_runtime_budget_reservations;
create policy ai_runtime_budget_reservations_client_deny
  on public.ai_runtime_budget_reservations
  for all
  to anon,authenticated
  using (false)
  with check (false);
