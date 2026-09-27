-- ============================================================
-- 114_ai_agent_outbound_capabilities.sql
-- Frozen Agent Revision capabilities + Task policy failure boundary.
--
-- Phase 9 — Outbound Capabilities & Tool Policy
-- ============================================================

create table if not exists public.ai_agent_revision_capabilities (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  agent_revision_id uuid not null,
  capability text not null
    check (
      capability ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
    ),
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint ai_agent_revision_capabilities_account_revision_fk
    foreign key (account_id, agent_revision_id)
    references public.ai_agent_revisions(account_id, id)
    on delete cascade,
  constraint ai_agent_revision_capabilities_unique
    unique (account_id, agent_revision_id, capability)
);

create index if not exists ai_agent_revision_capabilities_revision_idx
  on public.ai_agent_revision_capabilities (
    account_id,
    agent_revision_id,
    capability
  );

alter table public.ai_agent_revision_capabilities enable row level security;

drop policy if exists ai_agent_revision_capabilities_select
  on public.ai_agent_revision_capabilities;
create policy ai_agent_revision_capabilities_select
  on public.ai_agent_revision_capabilities
  for select
  using (public.is_account_member(account_id));

revoke all on table public.ai_agent_revision_capabilities
  from public, anon, authenticated;
grant select on table public.ai_agent_revision_capabilities
  to authenticated;
grant all on table public.ai_agent_revision_capabilities
  to service_role;

create or replace function public.replace_ai_agent_revision_capabilities(
  p_account_id uuid,
  p_agent_id uuid,
  p_revision_id uuid,
  p_capabilities jsonb,
  p_granted_by uuid default null
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_revision_status text;
  v_granted_by uuid;
  v_count integer := 0;
  v_capability text;
begin
  if p_capabilities is null
     or jsonb_typeof(p_capabilities) <> 'array' then
    raise exception 'AGENT_CAPABILITIES_ARRAY_REQUIRED';
  end if;

  if jsonb_array_length(p_capabilities) > 100 then
    raise exception 'AGENT_CAPABILITIES_TOO_MANY';
  end if;

  if auth.uid() is not null
     and not public.is_account_member(p_account_id, 'admin') then
    raise exception 'AGENT_CAPABILITIES_FORBIDDEN';
  end if;

  select revision.status
    into v_revision_status
  from public.ai_agent_revisions as revision
  where revision.account_id=p_account_id
    and revision.agent_id=p_agent_id
    and revision.id=p_revision_id
  for update;

  if v_revision_status is null then
    raise exception 'AGENT_REVISION_NOT_FOUND';
  end if;

  if v_revision_status <> 'draft' then
    raise exception 'AGENT_CAPABILITIES_REVISION_NOT_DRAFT';
  end if;

  v_granted_by:=coalesce(auth.uid(),p_granted_by);

  create temporary table if not exists pg_temp.agent_capability_replace (
    capability text primary key
  ) on commit drop;

  truncate table pg_temp.agent_capability_replace;

  for v_capability in
    select value
    from jsonb_array_elements_text(p_capabilities) as item(value)
  loop
    if v_capability !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' then
      raise exception 'AGENT_CAPABILITY_INVALID:%',v_capability;
    end if;

    insert into pg_temp.agent_capability_replace(capability)
    values (v_capability)
    on conflict do nothing;
  end loop;

  delete from public.ai_agent_revision_capabilities
  where account_id=p_account_id
    and agent_revision_id=p_revision_id;

  insert into public.ai_agent_revision_capabilities (
    account_id,
    agent_revision_id,
    capability,
    granted_by
  )
  select
    p_account_id,
    p_revision_id,
    capability,
    v_granted_by
  from pg_temp.agent_capability_replace
  order by capability;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.replace_ai_agent_revision_capabilities(
  uuid,uuid,uuid,jsonb,uuid
) from public,anon;
grant execute on function public.replace_ai_agent_revision_capabilities(
  uuid,uuid,uuid,jsonb,uuid
) to authenticated,service_role;

create or replace function public.fail_claimed_agent_task_policy(
  p_task_id uuid,
  p_worker_id text,
  p_error_code text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_task public.ai_agent_tasks%rowtype;
  v_error_code text;
begin
  if length(btrim(coalesce(p_worker_id,'')))=0 then
    raise exception 'AGENT_TASK_WORKER_ID_REQUIRED';
  end if;

  v_error_code:=left(
    regexp_replace(
      upper(coalesce(nullif(btrim(p_error_code),''),'TASK_POLICY_DENIED')),
      '[^A-Z0-9_]+',
      '_',
      'g'
    ),
    80
  );

  select *
    into v_task
  from public.ai_agent_tasks
  where id=p_task_id
  for update;

  if v_task.id is null
     or v_task.status<>'running'
     or v_task.claimed_by is distinct from p_worker_id
     or v_task.lease_expires_at is null
     or v_task.lease_expires_at<=now() then
    return false;
  end if;

  update public.ai_agent_task_outbound_messages
     set status='cancelled',
         claimed_by=null,
         lease_expires_at=null,
         error_code=v_error_code,
         error_detail='Task capability/tool policy rejected execution.'
   where account_id=v_task.account_id
     and task_id=v_task.id
     and status='reserved';

  update public.ai_agent_task_targets
     set status='failed',
         failure_code=v_error_code,
         next_action_at=null,
         claimed_by=null,
         lease_expires_at=null,
         available_at=now()
   where account_id=v_task.account_id
     and task_id=v_task.id
     and status in (
       'candidate',
       'eligible',
       'queued',
       'preparing',
       'contacted',
       'awaiting_reply',
       'replied',
       'in_progress'
     );

  update public.ai_agent_tasks
     set status='failed',
         completed_at=now(),
         claimed_by=null,
         lease_expires_at=null,
         available_at=now()
   where id=v_task.id;

  perform public.append_agent_task_event(
    v_task.account_id,
    v_task.id,
    null,
    null,
    'task.policy_failed',
    'service',
    p_worker_id,
    jsonb_build_object('error_code',v_error_code)
  );

  return true;
end;
$$;

revoke all on function public.fail_claimed_agent_task_policy(
  uuid,text,text
) from public,anon,authenticated;
grant execute on function public.fail_claimed_agent_task_policy(
  uuid,text,text
) to service_role;
