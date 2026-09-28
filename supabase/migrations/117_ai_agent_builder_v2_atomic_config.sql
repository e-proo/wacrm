-- ============================================================
-- 117_ai_agent_builder_v2_atomic_config.sql
-- Phase 10: atomically persist Builder V2 config + derived capabilities.
-- Additive only; published/superseded revisions remain immutable.
-- ============================================================

create or replace function public.update_ai_agent_builder_v2_config(
  p_account_id uuid,
  p_agent_id uuid,
  p_revision_id uuid,
  p_operational_mode text,
  p_outreach_policy jsonb,
  p_capabilities jsonb,
  p_actor_user_id uuid default null
) returns table (
  operational_mode text,
  outreach_policy jsonb,
  capability_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_status text;
  v_count integer;
begin
  if p_operational_mode not in ('reactive','outbound','both') then
    raise exception 'AGENT_BUILDER_OPERATIONAL_MODE_INVALID';
  end if;

  if p_outreach_policy is null
     or jsonb_typeof(p_outreach_policy) <> 'object' then
    raise exception 'AGENT_BUILDER_OUTREACH_POLICY_OBJECT_REQUIRED';
  end if;

  if p_outreach_policy ? 'bindings'
     and jsonb_typeof(p_outreach_policy->'bindings') <> 'array' then
    raise exception 'AGENT_BUILDER_BINDINGS_ARRAY_REQUIRED';
  end if;

  if p_capabilities is null
     or jsonb_typeof(p_capabilities) <> 'array' then
    raise exception 'AGENT_BUILDER_CAPABILITIES_ARRAY_REQUIRED';
  end if;

  select revision.status
    into v_status
  from public.ai_agent_revisions as revision
  where revision.account_id=p_account_id
    and revision.agent_id=p_agent_id
    and revision.id=p_revision_id
  for update;

  if v_status is null then
    raise exception 'AGENT_REVISION_NOT_FOUND';
  end if;

  if v_status <> 'draft' then
    raise exception 'AGENT_CAPABILITIES_REVISION_NOT_DRAFT';
  end if;

  update public.ai_agent_revisions
     set operational_mode=p_operational_mode,
         outreach_policy=p_outreach_policy
   where account_id=p_account_id
     and agent_id=p_agent_id
     and id=p_revision_id
     and status='draft';

  v_count := public.replace_ai_agent_revision_capabilities(
    p_account_id,
    p_agent_id,
    p_revision_id,
    p_capabilities,
    p_actor_user_id
  );

  return query
  select p_operational_mode, p_outreach_policy, v_count;
end;
$$;

revoke all on function public.update_ai_agent_builder_v2_config(
  uuid,uuid,uuid,text,jsonb,jsonb,uuid
) from public,anon,authenticated;

grant execute on function public.update_ai_agent_builder_v2_config(
  uuid,uuid,uuid,text,jsonb,jsonb,uuid
) to service_role;
