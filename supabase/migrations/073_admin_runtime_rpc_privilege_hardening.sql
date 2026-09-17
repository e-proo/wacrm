-- ============================================================
-- 073_admin_runtime_rpc_privilege_hardening.sql
-- Lock service-owned AI/admin runtime RPCs behind service_role.
--
-- These functions are invoked only after application-layer webhook/API
-- authentication and authorization. SECURITY DEFINER functions must not retain
-- PostgreSQL's default PUBLIC EXECUTE privilege, otherwise anon/authenticated
-- callers can invoke the privileged mutation boundary directly through REST.
-- ============================================================

-- Agent run lifecycle: webhook/service worker only.
revoke execute on function public.create_agent_run(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.create_agent_run(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text
) to service_role;

revoke execute on function public.claim_agent_run(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_agent_run(uuid, text, integer)
  to service_role;

-- Runtime budget reservations are internal worker state.
revoke execute on function public.reserve_ai_agent_runtime_budget(
  uuid, uuid, integer, integer
) from public, anon, authenticated;
grant execute on function public.reserve_ai_agent_runtime_budget(
  uuid, uuid, integer, integer
) to service_role;

revoke execute on function public.release_ai_agent_runtime_budget(uuid)
  from public, anon, authenticated;
grant execute on function public.release_ai_agent_runtime_budget(uuid)
  to service_role;

-- Change-request creation/approval/execution is mediated by authenticated API
-- handlers or the trusted-admin WhatsApp command parser, both of which call the
-- database through the server-side service client.
revoke execute on function public.create_change_request_v2(
  uuid, text, uuid, text, jsonb, bigint, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.create_change_request_v2(
  uuid, text, uuid, text, jsonb, bigint, text, text, uuid
) to service_role;

revoke execute on function public.approve_change_request_by_code_v2(
  uuid, integer, text, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.approve_change_request_by_code_v2(
  uuid, integer, text, uuid, uuid, uuid
) to service_role;

revoke execute on function public.approve_change_request_dashboard_v2(
  uuid, uuid, text, uuid
) from public, anon, authenticated;
grant execute on function public.approve_change_request_dashboard_v2(
  uuid, uuid, text, uuid
) to service_role;

revoke execute on function public.reject_change_request(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.reject_change_request(
  uuid, uuid, uuid, text
) to service_role;

revoke execute on function public.cancel_change_request(
  uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.cancel_change_request(
  uuid, uuid, uuid
) to service_role;

revoke execute on function public.claim_change_request_execution(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_change_request_execution(uuid, uuid)
  to service_role;

revoke execute on function public.complete_change_request_execution(
  uuid, uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_change_request_execution(
  uuid, uuid, uuid, jsonb
) to service_role;

revoke execute on function public.fail_change_request_execution(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.fail_change_request_execution(
  uuid, uuid, uuid, text
) to service_role;

-- OTP verification is performed by the authenticated server route using the
-- service client after its own admin authorization checks.
revoke execute on function public.verify_trusted_admin_otp_v2(
  uuid, uuid, text, uuid
) from public, anon, authenticated;
grant execute on function public.verify_trusted_admin_otp_v2(
  uuid, uuid, text, uuid
) to service_role;

-- Capability editing is intentionally callable by authenticated admins because
-- the route uses the user's Supabase client and the function itself enforces
-- account admin membership. Remove only anonymous/PUBLIC access.
revoke execute on function public.set_trusted_admin_capabilities(
  uuid, uuid, jsonb
) from public, anon;
grant execute on function public.set_trusted_admin_capabilities(
  uuid, uuid, jsonb
) to authenticated, service_role;
