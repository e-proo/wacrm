-- ============================================================
-- 121_ai_agent_task_reply_turn_state.sql
-- Persist the durable Task Target state after an inbound task-reply run sends
-- its response. This is orchestration state, not a business-domain mutation.
-- ============================================================

create or replace function public.complete_agent_task_reply_turn(
  p_run_id uuid,
  p_local_message_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_run public.ai_agent_runs%rowtype;
  v_target public.ai_agent_task_targets%rowtype;
begin
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

  if not exists (
    select 1
    from public.messages as message
    where message.id=p_local_message_id
      and message.conversation_id=v_run.conversation_id
      and message.ai_agent_run_id=v_run.id
  ) then
    raise exception 'AGENT_TASK_REPLY_MESSAGE_CONTEXT_MISMATCH';
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

  -- Never resurrect a terminal/human-owned target.
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

  update public.ai_agent_task_targets
     set status='awaiting_reply',
         last_outbound_message_id=p_local_message_id,
         next_action_at=null,
         available_at=pg_catalog.now(),
         claimed_by=null,
         lease_expires_at=null,
         failure_code=null
   where id=v_target.id
     and account_id=v_run.account_id
     and task_id=v_run.task_id
     and status in (
       'replied',
       'in_progress',
       'contacted',
       'awaiting_reply'
     );

  if not found then
    return false;
  end if;

  perform public.append_agent_task_event(
    v_run.account_id,
    v_run.task_id,
    v_run.task_target_id,
    v_run.id,
    'target.reply_sent',
    'service',
    'agent-task-reply',
    pg_catalog.jsonb_build_object(
      'local_message_id',p_local_message_id
    )
  );

  return true;
end;
$$;

revoke all on function public.complete_agent_task_reply_turn(uuid,uuid)
  from public,anon,authenticated;

grant execute on function public.complete_agent_task_reply_turn(uuid,uuid)
  to service_role;
