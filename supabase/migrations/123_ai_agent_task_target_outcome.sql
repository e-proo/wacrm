-- ============================================================
-- 123_ai_agent_task_target_outcome.sql
-- Persist a bounded model observation (declined/unavailable) against the
-- server-bound current Task Target. The model never supplies task/target ids.
-- ============================================================

create or replace function public.record_agent_task_target_outcome(
  p_run_id uuid,
  p_outcome text,
  p_detail text default null
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_run public.ai_agent_runs%rowtype;
  v_task public.ai_agent_tasks%rowtype;
  v_target public.ai_agent_task_targets%rowtype;
begin
  if p_outcome not in ('declined', 'unavailable') then
    raise exception 'AGENT_TASK_TARGET_OUTCOME_INVALID';
  end if;

  select run.*
    into v_run
  from public.ai_agent_runs as run
  where run.id=p_run_id
    and run.run_mode='inbound'
    and run.trigger_type='task_reply'
    and run.task_id is not null
    and run.task_target_id is not null
  for update;

  if v_run.id is null then
    return false;
  end if;

  select task.*
    into v_task
  from public.ai_agent_tasks as task
  where task.account_id=v_run.account_id
    and task.id=v_run.task_id
  for update;

  if v_task.id is null or v_task.status<>'running' then
    return false;
  end if;

  select target.*
    into v_target
  from public.ai_agent_task_targets as target
  where target.account_id=v_run.account_id
    and target.task_id=v_run.task_id
    and target.id=v_run.task_target_id
  for update;

  if v_target.id is null then
    return false;
  end if;

  if v_target.status in (
    'completed',
    'skipped',
    'failed',
    'opted_out',
    'exhausted',
    'paused_for_human'
  ) then
    return true;
  end if;

  if v_target.status not in (
    'replied',
    'in_progress',
    'awaiting_reply',
    'contacted'
  ) then
    return false;
  end if;

  update public.ai_agent_task_targets
     set status='completed',
         completed_at=coalesce(completed_at,pg_catalog.now()),
         next_action_at=null,
         available_at=pg_catalog.now(),
         claimed_by=null,
         lease_expires_at=null,
         failure_code=null
   where account_id=v_run.account_id
     and task_id=v_run.task_id
     and id=v_run.task_target_id;

  update public.ai_agent_task_outbound_messages
     set status='cancelled',
         error_code='TARGET_OUTCOME_RECORDED',
         claimed_by=null,
         lease_expires_at=null
   where account_id=v_run.account_id
     and task_id=v_run.task_id
     and task_target_id=v_run.task_target_id
     and status='reserved';

  update public.ai_agent_runs
     set status='failed',
         completed_at=coalesce(completed_at,pg_catalog.now()),
         error_code='TARGET_OUTCOME_RECORDED'
   where account_id=v_run.account_id
     and task_id=v_run.task_id
     and task_target_id=v_run.task_target_id
     and run_mode='outbound'
     and status='queued';

  perform public.append_agent_task_event(
    v_run.account_id,
    v_run.task_id,
    v_run.task_target_id,
    v_run.id,
    'target.completed',
    'service',
    'agent-task-outcome',
    pg_catalog.jsonb_build_object(
      'outcome',p_outcome,
      'detail',nullif(left(coalesce(p_detail,''),500),'')
    )
  );

  return true;
end;
$$;

revoke all on function public.record_agent_task_target_outcome(uuid,text,text)
  from public,anon,authenticated;

grant execute on function public.record_agent_task_target_outcome(uuid,text,text)
  to service_role;
