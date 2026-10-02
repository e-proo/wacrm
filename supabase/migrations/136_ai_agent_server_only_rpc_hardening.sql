-- ============================================================
-- 136_ai_agent_server_only_rpc_hardening.sql
-- Phase 16: remove direct client EXECUTE from Agent/runtime RPCs that are
-- service-owned and do not perform end-user authorization internally.
--
-- Deliberately NOT included:
--   publish_ai_agent_revision_atomic(...)
-- It is called with an authenticated client and performs an explicit
-- is_account_member(account,'admin') authorization check itself.
-- ============================================================

revoke all on function public.append_agent_run_event(
  uuid,uuid,text,text,text,jsonb
) from public,anon,authenticated;
grant execute on function public.append_agent_run_event(
  uuid,uuid,text,text,text,jsonb
) to service_role;

revoke all on function public.claim_next_agent_run(
  text,integer
) from public,anon,authenticated;
grant execute on function public.claim_next_agent_run(
  text,integer
) to service_role;

revoke all on function public.claim_ai_reply_slot(
  uuid,integer
) from public,anon,authenticated;
grant execute on function public.claim_ai_reply_slot(
  uuid,integer
) to service_role;

revoke all on function public.create_customer_intent(
  uuid,uuid,uuid,text,text,text,jsonb,text,uuid
) from public,anon,authenticated;
grant execute on function public.create_customer_intent(
  uuid,uuid,uuid,text,text,text,jsonb,text,uuid
) to service_role;

revoke all on function public.append_service_activity_event(
  uuid,text,uuid,text,text,text,jsonb
) from public,anon,authenticated;
grant execute on function public.append_service_activity_event(
  uuid,text,uuid,text,text,text,jsonb
) to service_role;

revoke all on function public.apply_service_agent_change(
  uuid,uuid,uuid,bigint,uuid,text,text,text,jsonb,uuid,text,uuid
) from public,anon,authenticated;
grant execute on function public.apply_service_agent_change(
  uuid,uuid,uuid,bigint,uuid,text,text,text,jsonb,uuid,text,uuid
) to service_role;

revoke all on function public.apply_service_pricing_change(
  uuid,uuid,uuid,bigint,uuid,text,text,text,text,numeric,numeric,text,jsonb,uuid
) from public,anon,authenticated;
grant execute on function public.apply_service_pricing_change(
  uuid,uuid,uuid,bigint,uuid,text,text,text,text,numeric,numeric,text,jsonb,uuid
) to service_role;
