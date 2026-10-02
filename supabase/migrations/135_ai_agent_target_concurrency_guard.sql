-- ============================================================
-- 135_ai_agent_target_concurrency_guard.sql
-- Phase 16 security hardening: re-check Task/account/agent target limits at
-- the serialized INSERT choke point so concurrent Tasks cannot race past
-- eligibility counts calculated earlier by their resolvers.
-- ============================================================

create or replace function public.enforce_ai_agent_task_target_scope_guard()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_task public.ai_agent_tasks%rowtype;
  v_control public.ai_agent_scope_controls%rowtype;
  v_count bigint;
  v_hour_limit integer;
  v_agent_day_limit integer;
begin
  select * into v_task
  from public.ai_agent_tasks
  where account_id=new.account_id
    and id=new.task_id;

  if v_task.id is null then
    raise exception 'AGENT_TASK_NOT_FOUND';
  end if;

  -- One account-wide lock protects Task maxTargets plus eligibility limits
  -- that span multiple Tasks/agents from concurrent worker races.
  perform pg_advisory_xact_lock(
    hashtextextended(new.account_id::text||':target-guard',6511)
  );

  select count(*) into v_count
  from public.ai_agent_task_targets
  where account_id=new.account_id
    and task_id=new.task_id;

  if v_count>=v_task.max_targets then
    raise exception 'AGENT_TASK_TARGET_LIMIT_EXCEEDED';
  end if;

  if jsonb_typeof(new.eligibility_snapshot->'max_new_contacts_per_hour')
       ='number' then
    v_hour_limit:=
      (new.eligibility_snapshot->>'max_new_contacts_per_hour')::integer;

    if v_hour_limit<1 or v_hour_limit>10000 then
      raise exception 'AGENT_TASK_HOURLY_CONTACT_LIMIT_INVALID';
    end if;

    select count(*) into v_count
    from public.ai_agent_task_targets
    where account_id=new.account_id
      and contact_id is not null
      and created_at>=now()-interval '1 hour';

    if v_count>=v_hour_limit then
      raise exception 'AGENT_ACCOUNT_HOURLY_TARGET_LIMIT_EXCEEDED';
    end if;
  end if;

  if jsonb_typeof(new.eligibility_snapshot->'max_contacts_per_agent_per_day')
       ='number' then
    v_agent_day_limit:=
      (new.eligibility_snapshot->>'max_contacts_per_agent_per_day')::integer;

    if v_agent_day_limit<1 or v_agent_day_limit>100000 then
      raise exception 'AGENT_TASK_DAILY_AGENT_CONTACT_LIMIT_INVALID';
    end if;

    select count(distinct target.contact_id) into v_count
    from public.ai_agent_task_targets as target
    join public.ai_agent_tasks as task
      on task.account_id=target.account_id
     and task.id=target.task_id
    where target.account_id=new.account_id
      and task.agent_id=v_task.agent_id
      and target.contact_id is not null
      and target.created_at>=date_trunc('day',now());

    if v_count>=v_agent_day_limit then
      raise exception 'AGENT_DAILY_TARGET_LIMIT_EXCEEDED';
    end if;
  end if;

  select * into v_control
  from public.ai_agent_scope_controls
  where account_id=new.account_id
    and scope_type='task_type'
    and scope_key=v_task.task_type||'@'||v_task.task_type_version::text;

  if found then
    if not v_control.is_enabled then
      raise exception 'AGENT_TASK_TYPE_DISABLED';
    end if;

    if v_control.daily_target_limit is not null then
      select count(*) into v_count
      from public.ai_agent_task_targets as target
      join public.ai_agent_tasks as task
        on task.account_id=target.account_id
       and task.id=target.task_id
      where target.account_id=new.account_id
        and task.task_type=v_task.task_type
        and task.task_type_version=v_task.task_type_version
        and target.created_at>=date_trunc('day',now());

      if v_count>=v_control.daily_target_limit then
        raise exception 'AGENT_TASK_TYPE_DAILY_TARGET_LIMIT_EXCEEDED';
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

    if v_control.daily_target_limit is not null then
      select count(*) into v_count
      from public.ai_agent_task_targets as target
      join public.ai_agent_tasks as task
        on task.account_id=target.account_id
       and task.id=target.task_id
      where target.account_id=new.account_id
        and task.channel=v_task.channel
        and target.created_at>=date_trunc('day',now());

      if v_count>=v_control.daily_target_limit then
        raise exception 'AGENT_CHANNEL_DAILY_TARGET_LIMIT_EXCEEDED';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_ai_agent_task_target_scope_guard()
  from public,anon,authenticated;
