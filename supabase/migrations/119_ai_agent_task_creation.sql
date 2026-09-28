-- ============================================================
-- 119_ai_agent_task_creation.sql
-- Generic, atomic Agent Task creation boundary.
--
-- Domain APIs validate their own Task Type / Builder contract first, then call
-- this service-role-only RPC. The kernel does not know Coverage/Services.
-- ============================================================

create or replace function public.create_ai_agent_task(
  p_account_id uuid,
  p_task_type text,
  p_task_type_version integer,
  p_agent_id uuid,
  p_agent_revision_id uuid,
  p_trigger_type text,
  p_trigger_ref text,
  p_objective text,
  p_task_context jsonb,
  p_target_policy jsonb,
  p_channel text,
  p_max_targets integer,
  p_max_attempts_per_target integer,
  p_budget_policy jsonb,
  p_scheduled_at timestamptz,
  p_idempotency_key text,
  p_correlation_id text,
  p_created_by uuid
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_agent public.ai_agents%rowtype;
  v_revision public.ai_agent_revisions%rowtype;
  v_existing uuid;
  v_task_id uuid;
  v_status text;
begin
  if length(btrim(coalesce(p_task_type, ''))) = 0
     or p_task_type_version < 1 then
    raise exception 'AGENT_TASK_TYPE_INVALID';
  end if;

  if p_trigger_type not in ('manual', 'scheduled', 'business_event', 'system') then
    raise exception 'AGENT_TASK_TRIGGER_INVALID';
  end if;

  if length(btrim(coalesce(p_objective, ''))) = 0 then
    raise exception 'AGENT_TASK_OBJECTIVE_REQUIRED';
  end if;

  if p_channel <> 'whatsapp' then
    raise exception 'AGENT_TASK_CHANNEL_INVALID';
  end if;

  if p_max_targets < 1 or p_max_targets > 10000 then
    raise exception 'AGENT_TASK_MAX_TARGETS_INVALID';
  end if;

  if p_max_attempts_per_target < 1 or p_max_attempts_per_target > 20 then
    raise exception 'AGENT_TASK_MAX_ATTEMPTS_INVALID';
  end if;

  if p_task_context is null or jsonb_typeof(p_task_context) <> 'object'
     or p_target_policy is null or jsonb_typeof(p_target_policy) <> 'object'
     or p_budget_policy is null or jsonb_typeof(p_budget_policy) <> 'object' then
    raise exception 'AGENT_TASK_POLICY_OBJECT_REQUIRED';
  end if;

  if length(btrim(coalesce(p_idempotency_key, ''))) < 16 then
    raise exception 'AGENT_TASK_IDEMPOTENCY_KEY_INVALID';
  end if;

  if length(btrim(coalesce(p_correlation_id, ''))) = 0 then
    raise exception 'AGENT_TASK_CORRELATION_ID_REQUIRED';
  end if;

  select task.id
    into v_existing
  from public.ai_agent_tasks as task
  where task.account_id = p_account_id
    and task.idempotency_key = p_idempotency_key;

  if v_existing is not null then
    return v_existing;
  end if;

  select agent.*
    into v_agent
  from public.ai_agents as agent
  where agent.account_id = p_account_id
    and agent.id = p_agent_id
  for share;

  if v_agent.id is null then
    raise exception 'AGENT_TASK_AGENT_NOT_FOUND';
  end if;

  if v_agent.status <> 'active' then
    raise exception 'AGENT_TASK_AGENT_NOT_ACTIVE';
  end if;

  if v_agent.published_revision_id is distinct from p_agent_revision_id then
    raise exception 'AGENT_TASK_REVISION_NOT_CURRENT_PUBLISHED';
  end if;

  select revision.*
    into v_revision
  from public.ai_agent_revisions as revision
  where revision.account_id = p_account_id
    and revision.agent_id = p_agent_id
    and revision.id = p_agent_revision_id
  for share;

  if v_revision.id is null or v_revision.status <> 'published' then
    raise exception 'AGENT_TASK_REVISION_NOT_PUBLISHED';
  end if;

  if v_revision.operational_mode not in ('outbound', 'both') then
    raise exception 'AGENT_TASK_REVISION_NOT_OUTBOUND';
  end if;

  v_status :=
    case
      when p_scheduled_at is not null and p_scheduled_at > pg_catalog.now()
        then 'scheduled'
      else 'queued'
    end;

  insert into public.ai_agent_tasks (
    account_id,
    task_type,
    task_type_version,
    agent_id,
    agent_revision_id,
    trigger_type,
    trigger_ref,
    status,
    objective,
    task_context,
    target_policy,
    channel,
    max_targets,
    max_attempts_per_target,
    budget_policy,
    scheduled_at,
    idempotency_key,
    correlation_id,
    created_by,
    available_at
  ) values (
    p_account_id,
    btrim(p_task_type),
    p_task_type_version,
    p_agent_id,
    p_agent_revision_id,
    p_trigger_type,
    nullif(btrim(coalesce(p_trigger_ref, '')), ''),
    v_status,
    btrim(p_objective),
    p_task_context,
    p_target_policy,
    p_channel,
    p_max_targets,
    p_max_attempts_per_target,
    p_budget_policy,
    p_scheduled_at,
    btrim(p_idempotency_key),
    btrim(p_correlation_id),
    p_created_by,
    case
      when p_scheduled_at is not null and p_scheduled_at > pg_catalog.now()
        then p_scheduled_at
      else pg_catalog.now()
    end
  )
  on conflict (account_id, idempotency_key) do nothing
  returning id into v_task_id;

  if v_task_id is null then
    select task.id
      into v_task_id
    from public.ai_agent_tasks as task
    where task.account_id = p_account_id
      and task.idempotency_key = p_idempotency_key;
  end if;

  if v_task_id is null then
    raise exception 'AGENT_TASK_CREATE_FAILED';
  end if;

  -- Only the inserting transaction records task.created. An idempotent replay
  -- that lost the INSERT race simply receives the existing task id.
  if not exists (
    select 1
    from public.ai_agent_task_events as event
    where event.account_id = p_account_id
      and event.task_id = v_task_id
      and event.event_type = 'task.created'
  ) then
    perform public.append_agent_task_event(
      p_account_id,
      v_task_id,
      null,
      null,
      'task.created',
      'user',
      p_created_by::text,
      pg_catalog.jsonb_build_object(
        'task_type', p_task_type,
        'task_type_version', p_task_type_version,
        'trigger_type', p_trigger_type,
        'status', v_status,
        'agent_revision_id', p_agent_revision_id
      )
    );
  end if;

  return v_task_id;
end;
$$;

revoke all on function public.create_ai_agent_task(
  uuid,text,integer,uuid,uuid,text,text,text,jsonb,jsonb,text,
  integer,integer,jsonb,timestamptz,text,text,uuid
) from public,anon,authenticated;

grant execute on function public.create_ai_agent_task(
  uuid,text,integer,uuid,uuid,text,text,text,jsonb,jsonb,text,
  integer,integer,jsonb,timestamptz,text,text,uuid
) to service_role;
