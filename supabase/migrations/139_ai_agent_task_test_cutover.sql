-- ============================================================
-- 139_ai_agent_task_test_cutover.sql
-- Phase 18: guarded TEST/STAGING pilot activation + operational rollback.
-- Reuses ai_runtime_policies, ai_agent_scope_controls and service_activity_events.
-- ============================================================

create or replace function public.inspect_ai_agent_task_test_cutover_readiness(
  p_account_id uuid
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_policy public.ai_runtime_policies%rowtype;
  v_scope public.ai_agent_scope_controls%rowtype;
  v_mode text := 'disabled';
  v_blockers text[] := '{}'::text[];
  v_enabled_triggers bigint := 0;
  v_pending_trigger_firings bigint := 0;
  v_nonterminal_tasks bigint := 0;
  v_sending_messages bigint := 0;
  v_reconciliation_messages bigint := 0;
  v_open_whatsapp_circuits bigint := 0;
begin
  select *
    into v_policy
  from public.ai_runtime_policies
  where account_id=p_account_id;

  select *
    into v_scope
  from public.ai_agent_scope_controls
  where account_id=p_account_id
    and scope_type='channel'
    and scope_key='whatsapp';

  if v_policy.account_id is null then
    v_blockers:=array_append(v_blockers,'RUNTIME_POLICY_MISSING');
  else
    if v_policy.kill_switch then
      v_blockers:=array_append(v_blockers,'KILL_SWITCH_ENABLED');
    end if;
    if not v_policy.multi_agent_enabled then
      v_blockers:=array_append(v_blockers,'MULTI_AGENT_DISABLED');
    end if;
    if not v_policy.recovery_worker_enabled then
      v_blockers:=array_append(v_blockers,'RECOVERY_WORKER_DISABLED');
    end if;
    if not v_policy.native_tools_enabled then
      v_blockers:=array_append(v_blockers,'NATIVE_TOOLS_DISABLED');
    end if;
    if not v_policy.proposal_tools_enabled then
      v_blockers:=array_append(v_blockers,'PROPOSAL_TOOLS_DISABLED');
    end if;

    if v_policy.daily_message_budget is null
       or v_policy.daily_message_budget < 1
       or v_policy.daily_message_budget > 50 then
      v_blockers:=array_append(
        v_blockers,
        'ACCOUNT_DAILY_MESSAGE_BUDGET_NOT_PILOT_BOUNDED'
      );
    end if;
  end if;

  if v_scope.id is null then
    v_blockers:=array_append(v_blockers,'WHATSAPP_SCOPE_CONTROL_MISSING');
  else
    if v_scope.daily_run_limit is null
       or v_scope.daily_run_limit < 1
       or v_scope.daily_run_limit > 10 then
      v_blockers:=array_append(
        v_blockers,
        'WHATSAPP_DAILY_RUN_LIMIT_NOT_PILOT_BOUNDED'
      );
    end if;

    if v_scope.daily_target_limit is null
       or v_scope.daily_target_limit < 1
       or v_scope.daily_target_limit > 10 then
      v_blockers:=array_append(
        v_blockers,
        'WHATSAPP_DAILY_TARGET_LIMIT_NOT_PILOT_BOUNDED'
      );
    end if;

    if v_scope.daily_message_limit is null
       or v_scope.daily_message_limit < 1
       or v_scope.daily_message_limit > 20 then
      v_blockers:=array_append(
        v_blockers,
        'WHATSAPP_DAILY_MESSAGE_LIMIT_NOT_PILOT_BOUNDED'
      );
    end if;
  end if;

  if v_policy.account_id is not null and v_scope.id is not null then
    if v_policy.outbound_task_delivery_enabled and v_scope.is_enabled then
      v_mode:='pilot';
    elsif not v_policy.outbound_task_delivery_enabled and not v_scope.is_enabled then
      v_mode:='disabled';
    else
      v_mode:='inconsistent';
      v_blockers:=array_append(
        v_blockers,
        'OUTBOUND_FLAG_CHANNEL_SCOPE_MISMATCH'
      );
    end if;
  elsif v_policy.account_id is not null and v_policy.outbound_task_delivery_enabled then
    v_mode:='inconsistent';
    v_blockers:=array_append(
      v_blockers,
      'OUTBOUND_ENABLED_WITHOUT_WHATSAPP_SCOPE'
    );
  end if;

  select count(*)
    into v_enabled_triggers
  from public.ai_agent_task_triggers
  where account_id=p_account_id
    and status='enabled';

  if v_enabled_triggers>0 then
    v_blockers:=array_append(
      v_blockers,
      'ENABLED_AUTOMATIC_TRIGGERS_PRESENT'
    );
  end if;

  select count(*)
    into v_pending_trigger_firings
  from public.ai_agent_task_trigger_firings
  where account_id=p_account_id
    and status in ('pending','claimed','failed');

  if v_pending_trigger_firings>0 then
    v_blockers:=array_append(
      v_blockers,
      'NONTERMINAL_TRIGGER_FIRINGS_PRESENT'
    );
  end if;

  select count(*)
    into v_nonterminal_tasks
  from public.ai_agent_tasks
  where account_id=p_account_id
    and status in (
      'validating','scheduled','queued','running','paused'
    );

  if v_nonterminal_tasks>0 then
    v_blockers:=array_append(
      v_blockers,
      'NONTERMINAL_AGENT_TASKS_PRESENT'
    );
  end if;

  select
    count(*) filter (where status='sending'),
    count(*) filter (where status='requires_reconciliation')
    into v_sending_messages,v_reconciliation_messages
  from public.ai_agent_task_outbound_messages
  where account_id=p_account_id;

  if v_sending_messages>0 then
    v_blockers:=array_append(
      v_blockers,
      'OUTBOUND_TRANSPORT_IN_FLIGHT'
    );
  end if;

  if v_reconciliation_messages>0 then
    v_blockers:=array_append(
      v_blockers,
      'OUTBOUND_RECONCILIATION_REQUIRED'
    );
  end if;

  select count(*)
    into v_open_whatsapp_circuits
  from public.ai_agent_circuit_breakers
  where account_id=p_account_id
    and scope_type='channel'
    and scope_key='whatsapp'
    and state='open'
    and (blocked_until is null or blocked_until>now());

  if v_open_whatsapp_circuits>0 then
    v_blockers:=array_append(
      v_blockers,
      'WHATSAPP_CHANNEL_CIRCUIT_OPEN'
    );
  end if;

  return jsonb_build_object(
    'account_id',p_account_id,
    'mode',v_mode,
    'ready',cardinality(v_blockers)=0,
    'blockers',to_jsonb(v_blockers),
    'runtime',jsonb_build_object(
      'multi_agent_enabled',coalesce(v_policy.multi_agent_enabled,false),
      'native_tools_enabled',coalesce(v_policy.native_tools_enabled,false),
      'proposal_tools_enabled',coalesce(v_policy.proposal_tools_enabled,false),
      'recovery_worker_enabled',coalesce(v_policy.recovery_worker_enabled,false),
      'outbound_task_delivery_enabled',
        coalesce(v_policy.outbound_task_delivery_enabled,false),
      'kill_switch',coalesce(v_policy.kill_switch,false),
      'daily_message_budget',v_policy.daily_message_budget
    ),
    'whatsapp_scope',jsonb_build_object(
      'exists',v_scope.id is not null,
      'enabled',coalesce(v_scope.is_enabled,false),
      'daily_run_limit',v_scope.daily_run_limit,
      'daily_target_limit',v_scope.daily_target_limit,
      'daily_message_limit',v_scope.daily_message_limit
    ),
    'counts',jsonb_build_object(
      'enabled_triggers',v_enabled_triggers,
      'nonterminal_trigger_firings',v_pending_trigger_firings,
      'nonterminal_tasks',v_nonterminal_tasks,
      'sending_messages',v_sending_messages,
      'reconciliation_messages',v_reconciliation_messages,
      'open_whatsapp_circuits',v_open_whatsapp_circuits
    )
  );
end;
$$;

revoke all on function public.inspect_ai_agent_task_test_cutover_readiness(uuid)
  from public,anon,authenticated;
grant execute on function public.inspect_ai_agent_task_test_cutover_readiness(uuid)
  to service_role;

create or replace function public.set_ai_agent_task_test_cutover_mode(
  p_account_id uuid,
  p_mode text,
  p_actor_id text default 'agent-task-cutover'
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_before jsonb;
  v_after jsonb;
begin
  if p_mode not in ('disabled','pilot') then
    raise exception 'AI_AGENT_TASK_CUTOVER_MODE_INVALID';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_account_id::text||':agent-task-cutover',6518)
  );

  if not exists (
    select 1 from public.ai_runtime_policies
    where account_id=p_account_id
  ) then
    raise exception 'AI_AGENT_TASK_CUTOVER_RUNTIME_POLICY_REQUIRED';
  end if;

  v_before:=public.inspect_ai_agent_task_test_cutover_readiness(
    p_account_id
  );

  if p_mode='pilot' then
    if coalesce((v_before->>'ready')::boolean,false)<>true then
      raise exception 'AI_AGENT_TASK_CUTOVER_NOT_READY:%',
        coalesce(v_before->'blockers','[]'::jsonb)::text;
    end if;

    update public.ai_runtime_policies
    set outbound_task_delivery_enabled=true,
        updated_at=now()
    where account_id=p_account_id;

    update public.ai_agent_scope_controls
    set is_enabled=true,
        updated_at=now()
    where account_id=p_account_id
      and scope_type='channel'
      and scope_key='whatsapp';

    if not found then
      raise exception 'AI_AGENT_TASK_CUTOVER_WHATSAPP_SCOPE_REQUIRED';
    end if;
  else
    update public.ai_runtime_policies
    set outbound_task_delivery_enabled=false,
        updated_at=now()
    where account_id=p_account_id;

    update public.ai_agent_scope_controls
    set is_enabled=false,
        updated_at=now()
    where account_id=p_account_id
      and scope_type='channel'
      and scope_key='whatsapp';
  end if;

  v_after:=public.inspect_ai_agent_task_test_cutover_readiness(
    p_account_id
  );

  perform public.append_service_activity_event(
    p_account_id,
    'ai_agent_task_cutover',
    p_account_id,
    case
      when p_mode='pilot' then 'agent_task.cutover.pilot_enabled'
      else 'agent_task.cutover.disabled'
    end,
    'service',
    nullif(btrim(coalesce(p_actor_id,'')),''),
    jsonb_build_object(
      'before',v_before,
      'after',v_after
    )
  );

  return jsonb_build_object(
    'mode',p_mode,
    'changed',
      coalesce(v_before->>'mode','disabled') is distinct from p_mode,
    'before',v_before,
    'after',v_after
  );
end;
$$;

revoke all on function public.set_ai_agent_task_test_cutover_mode(
  uuid,text,text
) from public,anon,authenticated;
grant execute on function public.set_ai_agent_task_test_cutover_mode(
  uuid,text,text
) to service_role;
