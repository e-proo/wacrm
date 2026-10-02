-- ============================================================
-- 130_ai_agent_outbound_guardrail_fail_closed.sql
-- Phase 14 hardening: the DB reservation choke point must remain fail-closed
-- even if a service caller bypasses the normal outbound worker preflight.
-- ============================================================

create or replace function public.enforce_ai_agent_outbound_message_budget()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_task public.ai_agent_tasks%rowtype;
  v_policy public.ai_runtime_policies%rowtype;
  v_control public.ai_agent_scope_controls%rowtype;
  v_budget record;
  v_count bigint;
  v_start timestamptz;
  v_task_message_budget bigint;
begin
  select * into v_task
  from public.ai_agent_tasks
  where account_id=new.account_id and id=new.task_id;

  if v_task.id is null then
    raise exception 'AGENT_TASK_NOT_FOUND';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.account_id::text||':message-guard',6512)
  );

  select * into v_policy
  from public.ai_runtime_policies
  where account_id=new.account_id;

  if not found then
    raise exception 'OUTBOUND_TASK_DELIVERY_DISABLED';
  end if;

  if v_policy.kill_switch then
    raise exception 'AI_KILL_SWITCH';
  end if;

  if not v_policy.multi_agent_enabled then
    raise exception 'MULTI_AGENT_DISABLED';
  end if;

  if not v_policy.outbound_task_delivery_enabled then
    raise exception 'OUTBOUND_TASK_DELIVERY_DISABLED';
  end if;

  if v_policy.daily_message_budget is not null then
    select count(*) into v_count
    from public.ai_agent_task_outbound_messages
    where account_id=new.account_id
      and created_at>=date_trunc('day',now())
      and status<>'cancelled';

    if v_count>=v_policy.daily_message_budget then
      raise exception 'ACCOUNT_DAILY_MESSAGE_BUDGET_EXCEEDED';
    end if;
  end if;

  if exists (
    select 1 from public.ai_agents
    where account_id=new.account_id
      and id=v_task.agent_id
      and status<>'active'
  ) then
    raise exception 'AGENT_PAUSED';
  end if;

  if v_task.status<>'running' then
    raise exception 'TASK_NOT_RUNNING';
  end if;

  if jsonb_typeof(v_task.budget_policy->'dailyMessageBudget')='number' then
    v_task_message_budget:=
      (v_task.budget_policy->>'dailyMessageBudget')::bigint;

    if v_task_message_budget<0 then
      raise exception 'TASK_MESSAGE_BUDGET_INVALID';
    end if;

    select count(*) into v_count
    from public.ai_agent_task_outbound_messages
    where account_id=new.account_id
      and task_id=v_task.id
      and created_at>=date_trunc('day',now())
      and status<>'cancelled';

    if v_count>=v_task_message_budget then
      raise exception 'TASK_DAILY_MESSAGE_BUDGET_EXCEEDED';
    end if;
  end if;

  for v_budget in
    select distinct on (period)
      period,max_messages,hard_action,agent_id
    from public.ai_agent_budget_policies
    where account_id=new.account_id
      and is_active=true
      and max_messages is not null
      and (agent_id=v_task.agent_id or agent_id is null)
    order by period,(agent_id is not null) desc,updated_at desc
  loop
    v_start:=case v_budget.period
      when 'monthly' then date_trunc('month',now())
      else date_trunc('day',now())
    end;

    select count(*) into v_count
    from public.ai_agent_task_outbound_messages as outbound
    join public.ai_agent_tasks as task
      on task.account_id=outbound.account_id
     and task.id=outbound.task_id
    where outbound.account_id=new.account_id
      and outbound.created_at>=v_start
      and outbound.status<>'cancelled'
      and (
        v_budget.agent_id is null
        or task.agent_id=v_task.agent_id
      );

    if v_count>=v_budget.max_messages then
      raise exception 'AGENT_BUDGET_MESSAGES_EXCEEDED:%',
        v_budget.hard_action;
    end if;
  end loop;

  select * into v_control
  from public.ai_agent_scope_controls
  where account_id=new.account_id
    and scope_type='task_type'
    and scope_key=v_task.task_type||'@'||v_task.task_type_version::text;

  if found then
    if not v_control.is_enabled then
      raise exception 'AGENT_TASK_TYPE_DISABLED';
    end if;

    if v_control.daily_message_limit is not null then
      select count(*) into v_count
      from public.ai_agent_task_outbound_messages as outbound
      join public.ai_agent_tasks as task
        on task.account_id=outbound.account_id
       and task.id=outbound.task_id
      where outbound.account_id=new.account_id
        and task.task_type=v_task.task_type
        and task.task_type_version=v_task.task_type_version
        and outbound.created_at>=date_trunc('day',now())
        and outbound.status<>'cancelled';

      if v_count>=v_control.daily_message_limit then
        raise exception 'TASK_TYPE_DAILY_MESSAGE_LIMIT_EXCEEDED';
      end if;
    end if;
  end if;

  select * into v_control
  from public.ai_agent_scope_controls
  where account_id=new.account_id
    and scope_type='channel'
    and scope_key=v_task.channel;

  if found then
    if not v_control.is_enabled then
      raise exception 'AGENT_CHANNEL_DISABLED';
    end if;

    if v_control.daily_message_limit is not null then
      select count(*) into v_count
      from public.ai_agent_task_outbound_messages as outbound
      join public.ai_agent_tasks as task
        on task.account_id=outbound.account_id
       and task.id=outbound.task_id
      where outbound.account_id=new.account_id
        and task.channel=v_task.channel
        and outbound.created_at>=date_trunc('day',now())
        and outbound.status<>'cancelled';

      if v_count>=v_control.daily_message_limit then
        raise exception 'CHANNEL_DAILY_MESSAGE_LIMIT_EXCEEDED';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_ai_agent_outbound_message_budget()
  from public,anon,authenticated;
