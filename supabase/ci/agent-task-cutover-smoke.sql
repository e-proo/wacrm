begin;

do $$
declare
  v_user uuid;
  v_account uuid;
  v_ready jsonb;
  v_change jsonb;
  v_blocked boolean := false;
begin
  select profile.user_id,profile.account_id
    into strict v_user,v_account
  from public.profiles as profile
  order by profile.created_at asc
  limit 1;

  insert into public.ai_runtime_policies(
    account_id,multi_agent_enabled,admin_plane_enabled,
    native_tools_enabled,proposal_tools_enabled,recovery_worker_enabled,
    outbound_task_delivery_enabled,kill_switch,max_runs_per_minute,
    daily_message_budget,updated_by
  ) values (
    v_account,true,true,true,true,true,false,false,30,10,v_user
  )
  on conflict (account_id) do update set
    multi_agent_enabled=true,
    native_tools_enabled=true,
    proposal_tools_enabled=true,
    recovery_worker_enabled=true,
    outbound_task_delivery_enabled=false,
    kill_switch=false,
    daily_message_budget=10,
    updated_by=v_user;

  insert into public.ai_agent_scope_controls(
    account_id,scope_type,scope_key,is_enabled,
    daily_run_limit,daily_target_limit,daily_message_limit,created_by
  ) values (
    v_account,'channel','whatsapp',false,
    5,5,10,v_user
  )
  on conflict (account_id,scope_type,scope_key)
  do update set
    is_enabled=false,
    daily_run_limit=5,
    daily_target_limit=5,
    daily_message_limit=10,
    updated_at=now();

  -- The clean pilot state must be ready while still disabled.
  v_ready:=public.inspect_ai_agent_task_test_cutover_readiness(v_account);
  if v_ready->>'mode'<>'disabled'
     or coalesce((v_ready->>'ready')::boolean,false)<>true
     or jsonb_array_length(v_ready->'blockers')<>0 then
    raise exception 'Phase 18 clean readiness failed: %',v_ready;
  end if;

  -- Unsafe account budget must prevent activation.
  update public.ai_runtime_policies
  set daily_message_budget=100
  where account_id=v_account;

  begin
    perform public.set_ai_agent_task_test_cutover_mode(
      v_account,'pilot','phase18-smoke'
    );
  exception when others then
    if position('AI_AGENT_TASK_CUTOVER_NOT_READY' in upper(sqlerrm))>0 then
      v_blocked:=true;
    else
      raise;
    end if;
  end;

  if not v_blocked then
    raise exception 'Unsafe pilot budget was allowed';
  end if;

  update public.ai_runtime_policies
  set daily_message_budget=10
  where account_id=v_account;

  -- Controlled activation flips BOTH durable gates atomically.
  v_change:=public.set_ai_agent_task_test_cutover_mode(
    v_account,'pilot','phase18-smoke'
  );

  if v_change->>'mode'<>'pilot'
     or v_change->'after'->>'mode'<>'pilot'
     or coalesce((v_change->'after'->>'ready')::boolean,false)<>true
     or not exists (
       select 1 from public.ai_runtime_policies
       where account_id=v_account
         and outbound_task_delivery_enabled=true
     )
     or not exists (
       select 1 from public.ai_agent_scope_controls
       where account_id=v_account
         and scope_type='channel'
         and scope_key='whatsapp'
         and is_enabled=true
     ) then
    raise exception 'Pilot activation failed: %',v_change;
  end if;

  -- Rollback disables transport + channel gate without touching inbound AI.
  v_change:=public.set_ai_agent_task_test_cutover_mode(
    v_account,'disabled','phase18-smoke'
  );

  if v_change->>'mode'<>'disabled'
     or v_change->'after'->>'mode'<>'disabled'
     or not exists (
       select 1 from public.ai_runtime_policies
       where account_id=v_account
         and outbound_task_delivery_enabled=false
         and multi_agent_enabled=true
     )
     or not exists (
       select 1 from public.ai_agent_scope_controls
       where account_id=v_account
         and scope_type='channel'
         and scope_key='whatsapp'
         and is_enabled=false
     ) then
    raise exception 'Pilot rollback failed: %',v_change;
  end if;

  if (
    select count(*)
    from public.service_activity_events
    where account_id=v_account
      and target_type='ai_agent_task_cutover'
      and target_id=v_account
      and actor_id='phase18-smoke'
      and event_type in (
        'agent_task.cutover.pilot_enabled',
        'agent_task.cutover.disabled'
      )
  )<>2 then
    raise exception 'Cutover audit events were not appended exactly once';
  end if;

  if has_function_privilege(
       'anon',
       'public.set_ai_agent_task_test_cutover_mode(uuid,text,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.set_ai_agent_task_test_cutover_mode(uuid,text,text)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.set_ai_agent_task_test_cutover_mode(uuid,text,text)',
       'EXECUTE'
     ) then
    raise exception 'Cutover control RPC privileges are unsafe';
  end if;

  raise notice 'Agent Task Phase 18 cutover smoke passed';
end
$$;

rollback;
