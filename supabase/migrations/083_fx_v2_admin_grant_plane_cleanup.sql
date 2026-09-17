-- 083_fx_v2_admin_grant_plane_cleanup.sql
-- Phase 5 hardening: admin-only FX grants must not remain attached to
-- customer-support revisions, even though runtime plane policy also fails
-- closed if such a stale grant is encountered.

delete from public.ai_agent_tool_grants g
using public.ai_agent_revisions r, public.ai_agents a
where r.id = g.agent_revision_id
  and r.account_id = g.account_id
  and a.id = r.agent_id
  and a.account_id = g.account_id
  and a.purpose is distinct from 'admin_operations'
  and g.tool_key in (
    'exchange_rates.admin_list_books',
    'exchange_rates.admin_list_pairs',
    'exchange_rates.admin_list_trade_requests',
    'exchange_rates.propose_pair_change',
    'exchange_rates.propose_trade_decision'
  );

do $$
begin
  if exists (
    select 1
    from public.ai_agent_tool_grants g
    join public.ai_agent_revisions r
      on r.id = g.agent_revision_id
     and r.account_id = g.account_id
    join public.ai_agents a
      on a.id = r.agent_id
     and a.account_id = g.account_id
    where a.purpose is distinct from 'admin_operations'
      and g.tool_key in (
        'exchange_rates.admin_list_books',
        'exchange_rates.admin_list_pairs',
        'exchange_rates.admin_list_trade_requests',
        'exchange_rates.propose_pair_change',
        'exchange_rates.propose_trade_decision'
      )
  ) then
    raise exception 'FX_ADMIN_GRANT_PLANE_CLEANUP_FAILED';
  end if;
end
$$;

comment on table public.ai_agent_tool_grants is
  'Frozen per-revision tool grants. FX V2 admin-only grants are restricted to admin_operations revisions; runtime plane/capability policy remains an independent fail-closed enforcement layer.';
