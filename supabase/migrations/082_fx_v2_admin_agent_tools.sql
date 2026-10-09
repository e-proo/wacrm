-- 082_fx_v2_admin_agent_tools.sql
-- Phase 5: pair-centric admin FX tools.

update public.ai_agent_tool_grants old
   set tool_key = 'exchange_rates.admin_list_pairs',
       tool_version = 1
 where old.tool_key = 'exchange_rates.admin_list_books'
   and not exists (
     select 1
     from public.ai_agent_tool_grants newer
     where newer.agent_revision_id = old.agent_revision_id
       and newer.tool_key = 'exchange_rates.admin_list_pairs'
   );

update public.ai_agent_tool_grants
   set tool_version = 2
 where tool_key = 'exchange_rates.propose_pair_change'
   and tool_version = 1;

insert into public.ai_agent_tool_grants (
  account_id, agent_revision_id, tool_key, tool_version,
  permission, constraints, granted_by, granted_at
)
select
  g.account_id, g.agent_revision_id,
  'exchange_rates.admin_list_trade_requests', 1,
  'read', g.constraints, g.granted_by, g.granted_at
from public.ai_agent_tool_grants g
where g.tool_key = 'exchange_rates.admin_list_pairs'
  and g.permission = 'read'
on conflict (agent_revision_id, tool_key) do nothing;

insert into public.ai_agent_tool_grants (
  account_id, agent_revision_id, tool_key, tool_version,
  permission, constraints, granted_by, granted_at
)
select
  g.account_id, g.agent_revision_id,
  'exchange_rates.propose_trade_decision', 1,
  'propose', g.constraints, g.granted_by, g.granted_at
from public.ai_agent_tool_grants g
where g.tool_key = 'exchange_rates.propose_pair_change'
  and g.permission = 'propose'
on conflict (agent_revision_id, tool_key) do nothing;

comment on table public.ai_agent_tool_grants is
  'Frozen per-revision tool grants. FX V2 Phase 5 replaces book-centric admin grants with pair-centric reads/rate proposals and adds trade-request review/decision tools only to revisions that already carried matching FX admin authority.';
