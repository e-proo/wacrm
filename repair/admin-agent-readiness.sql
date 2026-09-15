-- Admin-agent runtime readiness audit (READ ONLY)
-- Run in the TEST/STAGING Supabase SQL editor after applying migrations.
-- It does not modify data.

-- 1) Admin route -> active admin_operations agent -> published revision.
select
  r.account_id,
  r.id as route_id,
  r.name as route_name,
  r.is_active as route_active,
  r.priority,
  a.id as agent_id,
  a.name as agent_name,
  a.purpose,
  a.status as agent_status,
  a.published_revision_id,
  rev.status as revision_status,
  rev.revision_number,
  rev.model,
  rev.max_tool_rounds
from public.ai_agent_routes r
join public.ai_agents a
  on a.id = r.agent_id
left join public.ai_agent_revisions rev
  on rev.id = a.published_revision_id
where r.route_kind = 'admin'
  and r.channel = 'whatsapp'
order by r.account_id, r.is_active desc, r.priority desc;

-- Expected for the route that should receive a trusted admin:
-- route_active=true, purpose='admin_operations', agent_status='active',
-- revision_status='published', max_tool_rounds > 0.

-- 2) Exact tool grants frozen on the CURRENT published admin revision.
select
  a.account_id,
  a.id as agent_id,
  a.name as agent_name,
  rev.id as revision_id,
  rev.revision_number,
  g.tool_key,
  g.tool_version,
  g.permission,
  g.constraints
from public.ai_agents a
join public.ai_agent_revisions rev
  on rev.id = a.published_revision_id
left join public.ai_agent_tool_grants g
  on g.agent_revision_id = rev.id
where a.purpose = 'admin_operations'
order by a.account_id, a.id, g.tool_key;

-- For the current coverage/admin-services path, verify these exact grants exist:
-- coverage.get_rates@1 (read)
-- coverage.find_offers@2 (read)
-- coverage.admin_list_offers@1 (read)
-- coverage.admin_list_requests@1 (read)
-- change_requests.list_pending@1 (read)
-- Existing published revisions are immutable: fix a mismatch through a NEW
-- draft revision, then publish it. Do not mutate the published revision.

-- 3) Trusted WhatsApp admin identities + capabilities.
select
  account_id,
  id as identity_id,
  normalized_address,
  display_name,
  member_id,
  status,
  verified_at,
  revoked_at,
  allowed_capabilities,
  (allowed_capabilities ? 'coverage.read') as can_read_coverage,
  (allowed_capabilities ? 'change_requests.read') as can_read_pending_changes,
  (allowed_capabilities ? 'change_requests.approve') as can_approve_changes
from public.trusted_admin_identities
where channel = 'whatsapp'
order by account_id, status, created_at desc;

-- For the end-to-end coverage approval loop, the active identity needs at least:
--   coverage.read
--   change_requests.read
--   change_requests.approve
-- Additional proposal capabilities remain opt-in and should only be granted if
-- that administrator is intended to use the corresponding admin proposal tools.

-- 4) One-row-per-account coverage/admin readiness summary.
with active_admin_route as (
  select distinct on (r.account_id)
    r.account_id,
    r.id as route_id,
    r.agent_id,
    a.purpose,
    a.status as agent_status,
    a.published_revision_id,
    rev.status as revision_status,
    rev.max_tool_rounds
  from public.ai_agent_routes r
  join public.ai_agents a on a.id = r.agent_id
  left join public.ai_agent_revisions rev on rev.id = a.published_revision_id
  where r.route_kind = 'admin'
    and r.channel = 'whatsapp'
    and r.is_active = true
  order by r.account_id, r.priority desc
), required_grants(tool_key, tool_version, permission) as (
  values
    ('coverage.get_rates'::text, 1, 'read'::text),
    ('coverage.find_offers'::text, 2, 'read'::text),
    ('coverage.admin_list_offers'::text, 1, 'read'::text),
    ('coverage.admin_list_requests'::text, 1, 'read'::text),
    ('change_requests.list_pending'::text, 1, 'read'::text)
), grant_health as (
  select
    route.account_id,
    count(*) filter (
      where exists (
        select 1
        from public.ai_agent_tool_grants g
        where g.agent_revision_id = route.published_revision_id
          and g.tool_key = req.tool_key
          and g.tool_version = req.tool_version
          and g.permission = req.permission
      )
    ) as matching_grants,
    count(*) as required_grants
  from active_admin_route route
  cross join required_grants req
  group by route.account_id
), identity_health as (
  select
    account_id,
    count(*) filter (where status = 'active' and revoked_at is null) as active_identities,
    count(*) filter (
      where status = 'active'
        and revoked_at is null
        and allowed_capabilities ? 'coverage.read'
        and allowed_capabilities ? 'change_requests.read'
        and allowed_capabilities ? 'change_requests.approve'
    ) as coverage_approval_ready_identities
  from public.trusted_admin_identities
  where channel = 'whatsapp'
  group by account_id
)
select
  route.account_id,
  route.route_id,
  route.agent_id,
  route.purpose,
  route.agent_status,
  route.revision_status,
  route.max_tool_rounds,
  coalesce(grants.matching_grants, 0) as matching_required_grants,
  coalesce(grants.required_grants, 5) as required_grants,
  coalesce(ids.active_identities, 0) as active_trusted_admin_identities,
  coalesce(ids.coverage_approval_ready_identities, 0) as coverage_approval_ready_identities,
  (
    route.purpose = 'admin_operations'
    and route.agent_status = 'active'
    and route.revision_status = 'published'
    and coalesce(route.max_tool_rounds, 0) > 0
    and coalesce(grants.matching_grants, 0) = coalesce(grants.required_grants, 5)
    and coalesce(ids.coverage_approval_ready_identities, 0) > 0
  ) as coverage_admin_ready
from active_admin_route route
left join grant_health grants using (account_id)
left join identity_health ids using (account_id)
order by route.account_id;
