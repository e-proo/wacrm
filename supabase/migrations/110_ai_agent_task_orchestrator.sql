-- ============================================================
-- 110_ai_agent_task_orchestrator.sql
-- Durable Task Orchestrator claims / leases / retries.
--
-- This migration does NOT send messages and does NOT modify Meta transport.
-- It makes task/target scheduling and outbound run creation transactional.
-- ============================================================

alter table public.ai_agent_tasks
  add column if not exists available_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists claimed_by text;

update public.ai_agent_tasks
set available_at = coalesce(scheduled_at, created_at, now())
where available_at is null;

alter table public.ai_agent_tasks
  alter column available_at set default now(),
  alter column available_at set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.ai_agent_tasks'::regclass
      and conname = 'ai_agent_tasks_attempt_count_check'
  ) then
    alter table public.ai_agent_tasks
      add constraint ai_agent_tasks_attempt_count_check
      check (attempt_count between 0 and 10000) not valid;
  end if;
end
$$;

alter table public.ai_agent_tasks
  validate constraint ai_agent_tasks_attempt_count_check;

alter table public.ai_agent_task_targets
  add column if not exists available_at timestamptz,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists claimed_by text;

update public.ai_agent_task_targets
set available_at = coalesce(next_action_at, created_at, now())
where available_at is null;

alter table public.ai_agent_task_targets
  alter column available_at set default now(),
  alter column available_at set not null;

create index if not exists ai_agent_tasks_orchestrator_due_idx
  on public.ai_agent_tasks (available_at, created_at)
  where status in ('scheduled', 'queued', 'running');

create index if not exists ai_agent_task_targets_orchestrator_due_idx
  on public.ai_agent_task_targets (task_id, available_at, created_at)
  where status in ('eligible', 'queued', 'replied', 'preparing');

create index if not exists ai_agent_task_targets_lease_idx
  on public.ai_agent_task_targets (lease_expires_at)
  where lease_expires_at is not null;

create or replace function public.claim_next_agent_task(
  p_worker_id text,
  p_lease_secs integer default 60
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task_id uuid;
  v_account_id uuid;
begin
  if length(btrim(coalesce(p_worker_id, ''))) = 0 then
    raise exception 'AGENT_TASK_WORKER_ID_REQUIRED';
  end if;
  if p_lease_secs < 1 or p_lease_secs > 3600 then
    raise exception 'AGENT_TASK_LEASE_INVALID';
  end if;

  with candidate as (
    select t.id
    from public.ai_agent_tasks as t
    where t.status in ('scheduled', 'queued', 'running')
      and t.available_at <= now()
      and (t.scheduled_at is null or t.scheduled_at <= now())
      and (t.lease_expires_at is null or t.lease_expires_at < now())
    order by t.available_at asc, t.created_at asc, t.id asc
    for update skip locked
    limit 1
  )
  update public.ai_agent_tasks as t
     set status = 'running',
         started_at = coalesce(t.started_at, now()),
         claimed_by = p_worker_id,
         lease_expires_at = now() + make_interval(secs => p_lease_secs),
         attempt_count = t.attempt_count + 1
    from candidate
   where t.id = candidate.id
  returning t.id, t.account_id
       into v_task_id, v_account_id;

  if v_task_id is not null then
    perform public.append_agent_task_event(
      v_account_id,
      v_task_id,
      null,
      null,
      'task.claimed',
      'service',
      p_worker_id,
      jsonb_build_object('lease_secs', p_lease_secs)
    );
  end if;

  return v_task_id;
end;
$$;

revoke all on function public.claim_next_agent_task(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_next_agent_task(text, integer)
  to service_role;

create or replace function public.claim_next_agent_task_target(
  p_task_id uuid,
  p_worker_id text,
  p_lease_secs integer default 120
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id uuid;
  v_max_targets integer;
  v_max_attempts integer;
  v_target_id uuid;
begin
  if length(btrim(coalesce(p_worker_id, ''))) = 0 then
    raise exception 'AGENT_TASK_WORKER_ID_REQUIRED';
  end if;
  if p_lease_secs < 1 or p_lease_secs > 3600 then
    raise exception 'AGENT_TASK_TARGET_LEASE_INVALID';
  end if;

  select t.account_id, t.max_targets, t.max_attempts_per_target
    into v_account_id, v_max_targets, v_max_attempts
  from public.ai_agent_tasks as t
  where t.id = p_task_id
    and t.status = 'running'
    and t.claimed_by = p_worker_id
    and t.lease_expires_at > now()
  for update;

  if v_account_id is null then
    return null;
  end if;

  with ranked as (
    select
      target.id,
      row_number() over (
        order by target.created_at asc, target.id asc
      ) as target_ordinal
    from public.ai_agent_task_targets as target
    where target.task_id = p_task_id
  ),
  candidate as (
    select target.id
    from public.ai_agent_task_targets as target
    join ranked on ranked.id = target.id
    where target.account_id = v_account_id
      and target.task_id = p_task_id
      and ranked.target_ordinal <= v_max_targets
      and target.status in ('eligible', 'queued', 'replied')
      and target.attempt_count < v_max_attempts
      and target.available_at <= now()
      and (target.next_action_at is null or target.next_action_at <= now())
      and (target.lease_expires_at is null or target.lease_expires_at < now())
    order by target.available_at asc, target.created_at asc, target.id asc
    for update of target skip locked
    limit 1
  )
  update public.ai_agent_task_targets as target
     set status = 'preparing',
         claimed_by = p_worker_id,
         lease_expires_at = now() + make_interval(secs => p_lease_secs),
         attempt_count = target.attempt_count + 1,
         last_attempt_at = now(),
         failure_code = null
    from candidate
   where target.id = candidate.id
  returning target.id into v_target_id;

  if v_target_id is not null then
    perform public.append_agent_task_event(
      v_account_id,
      p_task_id,
      v_target_id,
      null,
      'target.claimed',
      'service',
      p_worker_id,
      jsonb_build_object('lease_secs', p_lease_secs)
    );
  end if;

  return v_target_id;
end;
$$;

revoke all on function public.claim_next_agent_task_target(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_next_agent_task_target(uuid, text, integer)
  to service_role;

create or replace function public.release_agent_task_claim(
  p_task_id uuid,
  p_worker_id text,
  p_min_delay_secs integer default 5
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id uuid;
  v_max_attempts integer;
  v_next_due timestamptz;
begin
  if p_min_delay_secs < 0 or p_min_delay_secs > 86400 then
    raise exception 'AGENT_TASK_RELEASE_DELAY_INVALID';
  end if;

  select account_id, max_attempts_per_target
    into v_account_id, v_max_attempts
  from public.ai_agent_tasks
  where id = p_task_id
    and status = 'running'
    and claimed_by = p_worker_id
  for update;

  if v_account_id is null then
    return false;
  end if;

  select min(
    greatest(
      target.available_at,
      coalesce(target.next_action_at, target.available_at)
    )
  )
  into v_next_due
  from public.ai_agent_task_targets as target
  where target.account_id = v_account_id
    and target.task_id = p_task_id
    and target.status in ('eligible', 'queued', 'replied')
    and target.attempt_count < v_max_attempts;

  update public.ai_agent_tasks
     set claimed_by = null,
         lease_expires_at = null,
         available_at = greatest(
           now() + make_interval(secs => p_min_delay_secs),
           coalesce(
             v_next_due,
             now() + make_interval(secs => p_min_delay_secs)
           )
         )
   where id = p_task_id
     and status = 'running'
     and claimed_by = p_worker_id;

  perform public.append_agent_task_event(
    v_account_id,
    p_task_id,
    null,
    null,
    'task.released',
    'service',
    p_worker_id,
    jsonb_build_object(
      'next_available_at',
      (
        select available_at::text
        from public.ai_agent_tasks
        where id = p_task_id
      )
    )
  );

  return true;
end;
$$;

revoke all on function public.release_agent_task_claim(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.release_agent_task_claim(uuid, text, integer)
  to service_role;

create or replace function public.create_claimed_agent_task_execution(
  p_task_id uuid,
  p_task_target_id uuid,
  p_worker_id text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.ai_agent_tasks%rowtype;
  v_target public.ai_agent_task_targets%rowtype;
  v_provider_connection_id uuid;
  v_run_id uuid;
  v_idempotency_key text;
begin
  select *
    into v_task
  from public.ai_agent_tasks
  where id = p_task_id
  for update;

  if v_task.id is null
     or v_task.status <> 'running'
     or v_task.claimed_by is distinct from p_worker_id
     or v_task.lease_expires_at is null
     or v_task.lease_expires_at <= now() then
    raise exception 'AGENT_TASK_CLAIM_LOST';
  end if;

  select *
    into v_target
  from public.ai_agent_task_targets
  where id = p_task_target_id
    and account_id = v_task.account_id
    and task_id = v_task.id
  for update;

  if v_target.id is null
     or v_target.status <> 'preparing'
     or v_target.claimed_by is distinct from p_worker_id
     or v_target.lease_expires_at is null
     or v_target.lease_expires_at <= now() then
    raise exception 'AGENT_TASK_TARGET_CLAIM_LOST';
  end if;

  if v_target.conversation_id is null then
    raise exception 'AGENT_TASK_TARGET_CONVERSATION_REQUIRED';
  end if;

  select r.provider_connection_id
    into v_provider_connection_id
  from public.ai_agent_revisions as r
  where r.account_id = v_task.account_id
    and r.agent_id = v_task.agent_id
    and r.id = v_task.agent_revision_id
    and r.status in ('published', 'superseded');

  if v_provider_connection_id is null then
    raise exception 'AGENT_TASK_REVISION_NOT_EXECUTABLE';
  end if;

  v_idempotency_key :=
    'task:' || v_task.id::text ||
    ':target:' || v_target.id::text ||
    ':attempt:' || v_target.attempt_count::text ||
    ':revision:' || v_task.agent_revision_id::text;

  v_run_id := public.create_agent_execution(
    v_task.account_id,
    v_target.conversation_id,
    null,
    v_task.agent_id,
    v_task.agent_revision_id,
    v_provider_connection_id,
    null,
    'agent_task_orchestrator',
    'customer',
    'outbound',
    v_task.id,
    v_target.id,
    'task_target',
    'attempt:' || v_target.attempt_count::text,
    v_target.counterparty_role,
    v_idempotency_key
  );

  update public.ai_agent_task_targets
     set status = 'in_progress',
         claimed_by = null,
         lease_expires_at = null,
         available_at = now(),
         next_action_at = null,
         failure_code = null
   where id = v_target.id;

  perform public.append_agent_task_event(
    v_task.account_id,
    v_task.id,
    v_target.id,
    v_run_id,
    'target.run_created',
    'service',
    p_worker_id,
    jsonb_build_object(
      'attempt', v_target.attempt_count,
      'idempotency_key', v_idempotency_key
    )
  );

  return v_run_id;
end;
$$;

revoke all on function public.create_claimed_agent_task_execution(
  uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.create_claimed_agent_task_execution(
  uuid, uuid, text
) to service_role;

create or replace function public.retry_agent_task_target_claim(
  p_task_id uuid,
  p_task_target_id uuid,
  p_worker_id text,
  p_error_code text,
  p_delay_secs integer default 60
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.ai_agent_tasks%rowtype;
  v_target public.ai_agent_task_targets%rowtype;
  v_status text;
begin
  if p_delay_secs < 0 or p_delay_secs > 86400 then
    raise exception 'AGENT_TASK_RETRY_DELAY_INVALID';
  end if;

  select *
    into v_task
  from public.ai_agent_tasks
  where id = p_task_id
  for update;

  select *
    into v_target
  from public.ai_agent_task_targets
  where id = p_task_target_id
    and task_id = p_task_id
  for update;

  if v_task.id is null
     or v_target.id is null
     or v_target.account_id <> v_task.account_id
     or v_target.status <> 'preparing'
     or v_target.claimed_by is distinct from p_worker_id then
    return null;
  end if;

  if v_target.attempt_count >= v_task.max_attempts_per_target then
    v_status := 'exhausted';

    update public.ai_agent_task_targets
       set status = 'exhausted',
           claimed_by = null,
           lease_expires_at = null,
           completed_at = now(),
           failure_code = nullif(btrim(coalesce(p_error_code, '')), '')
     where id = v_target.id;
  else
    v_status := 'queued';

    update public.ai_agent_task_targets
       set status = 'queued',
           claimed_by = null,
           lease_expires_at = null,
           available_at = now() + make_interval(secs => p_delay_secs),
           next_action_at = now() + make_interval(secs => p_delay_secs),
           failure_code = nullif(btrim(coalesce(p_error_code, '')), '')
     where id = v_target.id;
  end if;

  perform public.append_agent_task_event(
    v_task.account_id,
    v_task.id,
    v_target.id,
    null,
    case
      when v_status = 'exhausted' then 'target.exhausted'
      else 'target.retry_scheduled'
    end,
    'service',
    p_worker_id,
    jsonb_build_object(
      'attempt', v_target.attempt_count,
      'error_code', coalesce(p_error_code, ''),
      'delay_secs',
        case when v_status = 'queued' then p_delay_secs else 0 end
    )
  );

  return v_status;
end;
$$;

revoke all on function public.retry_agent_task_target_claim(
  uuid, uuid, text, text, integer
) from public, anon, authenticated;
grant execute on function public.retry_agent_task_target_claim(
  uuid, uuid, text, text, integer
) to service_role;

create or replace function public.schedule_agent_task_target(
  p_task_id uuid,
  p_task_target_id uuid,
  p_next_action_at timestamptz,
  p_reason text default 'followup'
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id uuid;
begin
  if p_next_action_at is null or p_next_action_at <= now() then
    raise exception 'AGENT_TASK_NEXT_ACTION_MUST_BE_FUTURE';
  end if;

  select account_id
    into v_account_id
  from public.ai_agent_tasks
  where id = p_task_id
    and status in ('queued', 'running')
  for update;

  if v_account_id is null then
    return false;
  end if;

  update public.ai_agent_task_targets
     set status = 'queued',
         available_at = p_next_action_at,
         next_action_at = p_next_action_at,
         claimed_by = null,
         lease_expires_at = null
   where id = p_task_target_id
     and account_id = v_account_id
     and task_id = p_task_id
     and status in ('in_progress', 'contacted', 'awaiting_reply', 'replied');

  if not found then
    return false;
  end if;

  perform public.append_agent_task_event(
    v_account_id,
    p_task_id,
    p_task_target_id,
    null,
    'followup.scheduled',
    'service',
    'task-orchestrator',
    jsonb_build_object(
      'next_action_at', p_next_action_at,
      'reason', coalesce(p_reason, 'followup')
    )
  );

  return true;
end;
$$;

revoke all on function public.schedule_agent_task_target(
  uuid, uuid, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.schedule_agent_task_target(
  uuid, uuid, timestamptz, text
) to service_role;

create or replace function public.pause_agent_task(
  p_account_id uuid,
  p_task_id uuid,
  p_actor_id text default 'task-orchestrator'
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.ai_agent_tasks
     set status = 'paused',
         claimed_by = null,
         lease_expires_at = null
   where id = p_task_id
     and account_id = p_account_id
     and status in ('scheduled', 'queued', 'running');

  if not found then
    return false;
  end if;

  perform public.append_agent_task_event(
    p_account_id,
    p_task_id,
    null,
    null,
    'task.paused',
    'service',
    p_actor_id,
    '{}'::jsonb
  );

  return true;
end;
$$;

revoke all on function public.pause_agent_task(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.pause_agent_task(uuid, uuid, text)
  to service_role;

create or replace function public.resume_agent_task(
  p_account_id uuid,
  p_task_id uuid,
  p_actor_id text default 'task-orchestrator'
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.ai_agent_tasks
     set status = 'queued',
         claimed_by = null,
         lease_expires_at = null,
         available_at = now()
   where id = p_task_id
     and account_id = p_account_id
     and status = 'paused';

  if not found then
    return false;
  end if;

  perform public.append_agent_task_event(
    p_account_id,
    p_task_id,
    null,
    null,
    'task.resumed',
    'service',
    p_actor_id,
    '{}'::jsonb
  );

  return true;
end;
$$;

revoke all on function public.resume_agent_task(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.resume_agent_task(uuid, uuid, text)
  to service_role;

create or replace function public.cancel_agent_task(
  p_account_id uuid,
  p_task_id uuid,
  p_actor_id text default 'task-orchestrator'
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.ai_agent_tasks
     set status = 'cancelled',
         claimed_by = null,
         lease_expires_at = null,
         completed_at = coalesce(completed_at, now())
   where id = p_task_id
     and account_id = p_account_id
     and status not in (
       'completed',
       'partially_completed',
       'failed',
       'cancelled'
     );

  if not found then
    return false;
  end if;

  perform public.append_agent_task_event(
    p_account_id,
    p_task_id,
    null,
    null,
    'task.cancelled',
    'service',
    p_actor_id,
    '{}'::jsonb
  );

  return true;
end;
$$;

revoke all on function public.cancel_agent_task(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.cancel_agent_task(uuid, uuid, text)
  to service_role;

create or replace function public.sweep_agent_task_claims(
  p_now timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_tasks_recovered integer := 0;
  v_targets_requeued integer := 0;
  v_targets_exhausted integer := 0;
  v_next_status text;
begin
  for r in
    select
      target.id,
      target.account_id,
      target.task_id,
      target.attempt_count,
      task.max_attempts_per_target
    from public.ai_agent_task_targets as target
    join public.ai_agent_tasks as task
      on task.account_id = target.account_id
     and task.id = target.task_id
    where target.status = 'preparing'
      and target.lease_expires_at is not null
      and target.lease_expires_at < p_now
    order by target.lease_expires_at asc
    for update of target skip locked
  loop
    if r.attempt_count >= r.max_attempts_per_target then
      v_next_status := 'exhausted';

      update public.ai_agent_task_targets
         set status = 'exhausted',
             claimed_by = null,
             lease_expires_at = null,
             completed_at = coalesce(completed_at, p_now),
             failure_code = coalesce(
               failure_code,
               'LEASE_LOST_MAX_ATTEMPTS'
             )
       where id = r.id;

      v_targets_exhausted := v_targets_exhausted + 1;
    else
      v_next_status := 'queued';

      update public.ai_agent_task_targets
         set status = 'queued',
             claimed_by = null,
             lease_expires_at = null,
             available_at = p_now,
             next_action_at = p_now,
             failure_code = coalesce(
               failure_code,
               'LEASE_LOST_RETRY'
             )
       where id = r.id;

      v_targets_requeued := v_targets_requeued + 1;
    end if;

    perform public.append_agent_task_event(
      r.account_id,
      r.task_id,
      r.id,
      null,
      case
        when v_next_status = 'exhausted' then 'target.exhausted'
        else 'target.lease_recovered'
      end,
      'system',
      'task-orchestrator-sweep',
      jsonb_build_object('attempt', r.attempt_count)
    );
  end loop;

  for r in
    select id, account_id
    from public.ai_agent_tasks
    where status = 'running'
      and lease_expires_at is not null
      and lease_expires_at < p_now
    order by lease_expires_at asc
    for update skip locked
  loop
    update public.ai_agent_tasks
       set claimed_by = null,
           lease_expires_at = null,
           available_at = p_now
     where id = r.id;

    v_tasks_recovered := v_tasks_recovered + 1;

    perform public.append_agent_task_event(
      r.account_id,
      r.id,
      null,
      null,
      'task.lease_recovered',
      'system',
      'task-orchestrator-sweep',
      '{}'::jsonb
    );
  end loop;

  return jsonb_build_object(
    'tasks_recovered', v_tasks_recovered,
    'targets_requeued', v_targets_requeued,
    'targets_exhausted', v_targets_exhausted
  );
end;
$$;

revoke all on function public.sweep_agent_task_claims(timestamptz)
  from public, anon, authenticated;
grant execute on function public.sweep_agent_task_claims(timestamptz)
  to service_role;
