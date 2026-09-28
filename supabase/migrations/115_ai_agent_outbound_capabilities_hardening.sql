-- ============================================================
-- 115_ai_agent_outbound_capabilities_hardening.sql
-- Harden Phase 9 capability mutation after TEST advisor review.
--
-- Keep capability mutation behind authenticated application routes:
-- human authorization is checked in the API, then a service-role RPC performs
-- the atomic draft-only replacement. The function is no longer directly
-- callable by the authenticated REST role.
-- ============================================================

revoke execute on function public.replace_ai_agent_revision_capabilities(
  uuid,uuid,uuid,jsonb,uuid
) from authenticated;

grant execute on function public.replace_ai_agent_revision_capabilities(
  uuid,uuid,uuid,jsonb,uuid
) to service_role;

create index if not exists ai_agent_revision_capabilities_granted_by_idx
  on public.ai_agent_revision_capabilities (granted_by)
  where granted_by is not null;
