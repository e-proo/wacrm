do $$
declare
  v_user uuid := '00000000-0000-4000-8000-000000000110';
  v_account uuid;
  v_contact_1 uuid := gen_random_uuid();
  v_contact_2 uuid := gen_random_uuid();
  v_conv_1 uuid := gen_random_uuid();
  v_conv_2 uuid := gen_random_uuid();
  v_connection uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid();
  v_target_1 uuid := gen_random_uuid();
  v_target_2 uuid := gen_random_uuid();
  v_cancel_task uuid := gen_random_uuid();
  v_cancel_target uuid := gen_random_uuid();
  v_recovery_task uuid := gen_random_uuid();
  v_recovery_target uuid := gen_random_uuid();
  v_claim uuid;
  v_other_claim uuid;
  v_target_claim uuid;
  v_second_target_claim uuid;
  v_run uuid;
  v_cancel_blocked boolean := false;
  v_retry_status text;
  v_sweep jsonb;
  v_msg_count_before bigint;
  v_msg_count_after bigint;
begin
  insert into auth.users (id,email,raw_user_meta_data)
  values (
    v_user,
    'agent-task-orchestrator-smoke@example.test',
    '{"full_name":"Task Orchestrator Smoke"}'::jsonb
  );

  select account_id into strict v_account
  from public.profiles
  where user_id=v_user;

  insert into public.contacts (id,user_id,account_id,phone,name)
  values
    (v_contact_1,v_user,v_account,'+967700000110','Supplier One'),
    (v_contact_2,v_user,v_account,'+967700000111','Supplier Two');

  insert into public.conversations (id,user_id,account_id,contact_id)
  values
    (v_conv_1,v_user,v_account,v_contact_1),
    (v_conv_2,v_user,v_account,v_contact_2);

  insert into public.ai_provider_connections (
    id,account_id,name,preset_id,protocol,api_root,
    encrypted_api_key,connection_fingerprint,status
  ) values (
    v_connection,v_account,'Task Orchestrator Provider',
    'task-orchestrator-smoke','openai','https://example.test/v1',
    'encrypted-smoke-key','task-orchestrator-smoke-110','verified'
  );

  insert into public.ai_agents (id,account_id,slug,name,purpose,status)
  values (
    v_agent,v_account,'task-orchestrator-smoke-agent',
    'Task Orchestrator Smoke Agent','custom','active'
  );

  insert into public.ai_agent_revisions (
    id,account_id,agent_id,revision_number,status,
    provider_connection_id,model
  ) values (
    v_revision,v_account,v_agent,1,'published',
    v_connection,'smoke-model'
  );

  insert into public.ai_agent_tasks (
    id,account_id,task_type,task_type_version,agent_id,agent_revision_id,
    trigger_type,status,objective,channel,max_targets,max_attempts_per_target,
    idempotency_key,correlation_id,created_by
  ) values (
    v_task,v_account,'coverage.sourcing',1,v_agent,v_revision,
    'manual','queued','Bounded supplier sourcing','whatsapp',1,2,
    'task-orchestrator-smoke-110','task-orchestrator-correlation-110',v_user
  );

  insert into public.ai_agent_task_targets (
    id,account_id,task_id,contact_id,counterparty_role,status,
    conversation_id,idempotency_key,created_at
  ) values
    (
      v_target_1,v_account,v_task,v_contact_1,'supplier','queued',
      v_conv_1,'task-orchestrator-target-1-110',now()-interval '2 seconds'
    ),
    (
      v_target_2,v_account,v_task,v_contact_2,'supplier','queued',
      v_conv_2,'task-orchestrator-target-2-110',now()-interval '1 second'
    );

  v_claim := public.claim_next_agent_task('worker-a',120);
  if v_claim <> v_task then
    raise exception 'expected worker-a to claim primary task';
  end if;

  v_other_claim := public.claim_next_agent_task('worker-b',120);
  if v_other_claim is not null then
    raise exception 'second worker claimed leased task';
  end if;

  v_target_claim := public.claim_next_agent_task_target(v_task,'worker-a',120);
  if v_target_claim <> v_target_1 then
    raise exception 'deterministic first target claim failed';
  end if;

  select count(*) into v_msg_count_before
  from public.messages
  where conversation_id in (v_conv_1,v_conv_2);

  v_run := public.create_claimed_agent_task_execution(
    v_task,v_target_1,'worker-a'
  );
  if v_run is null then
    raise exception 'outbound run was not created';
  end if;

  if not exists (
    select 1
    from public.ai_agent_runs
    where id=v_run
      and run_mode='outbound'
      and task_id=v_task
      and task_target_id=v_target_1
      and inbound_message_id is null
      and status='queued'
  ) then
    raise exception 'outbound run shape invalid';
  end if;

  select count(*) into v_msg_count_after
  from public.messages
  where conversation_id in (v_conv_1,v_conv_2);

  if v_msg_count_after <> v_msg_count_before then
    raise exception 'Phase 5 must not send or persist outbound messages';
  end if;

  v_second_target_claim := public.claim_next_agent_task_target(
    v_task,'worker-a',120
  );
  if v_second_target_claim is not null then
    raise exception 'max_targets limit was bypassed';
  end if;

  if not public.schedule_agent_task_target(
    v_task,v_target_1,now()+interval '2 minutes','smoke-followup'
  ) then
    raise exception 'followup scheduling failed';
  end if;

  if not public.pause_agent_task(v_account,v_task,'smoke') then
    raise exception 'pause failed';
  end if;

  if public.schedule_agent_task_target(
    v_task,v_target_1,now()+interval '3 minutes','paused-followup'
  ) then
    raise exception 'paused task accepted a new followup';
  end if;

  if not public.resume_agent_task(v_account,v_task,'smoke') then
    raise exception 'resume failed';
  end if;

  update public.ai_agent_task_targets
  set available_at=now()-interval '1 second',
      next_action_at=now()-interval '1 second'
  where id=v_target_1;

  v_claim := public.claim_next_agent_task('worker-a',120);
  if v_claim <> v_task then
    raise exception 'resumed task was not claimable';
  end if;

  v_target_claim := public.claim_next_agent_task_target(
    v_task,'worker-a',120
  );
  if v_target_claim <> v_target_1 then
    raise exception 'scheduled followup target was not claimable';
  end if;

  v_retry_status := public.retry_agent_task_target_claim(
    v_task,v_target_1,'worker-a','SMOKE_FAILURE',0
  );
  if v_retry_status <> 'exhausted' then
    raise exception 'attempt limit did not exhaust target';
  end if;

  perform public.release_agent_task_claim(v_task,'worker-a',1);

  insert into public.ai_agent_tasks (
    id,account_id,task_type,task_type_version,agent_id,agent_revision_id,
    trigger_type,status,objective,channel,max_targets,max_attempts_per_target,
    idempotency_key,correlation_id,created_by,available_at
  ) values (
    v_cancel_task,v_account,'coverage.sourcing',1,v_agent,v_revision,
    'manual','queued','Cancellation race smoke','whatsapp',1,2,
    'task-orchestrator-cancel-110',
    'task-orchestrator-cancel-correlation-110',v_user,
    now()-interval '1 second'
  );

  insert into public.ai_agent_task_targets (
    id,account_id,task_id,contact_id,counterparty_role,status,
    conversation_id,idempotency_key
  ) values (
    v_cancel_target,v_account,v_cancel_task,v_contact_1,'supplier','queued',
    v_conv_1,'task-orchestrator-cancel-target-110'
  );

  v_claim := public.claim_next_agent_task('worker-cancel',120);
  if v_claim <> v_cancel_task then
    raise exception 'cancel task claim failed';
  end if;

  v_target_claim := public.claim_next_agent_task_target(
    v_cancel_task,'worker-cancel',120
  );
  if v_target_claim <> v_cancel_target then
    raise exception 'cancel target claim failed';
  end if;

  if not public.cancel_agent_task(v_account,v_cancel_task,'smoke') then
    raise exception 'cancel failed';
  end if;

  begin
    perform public.create_claimed_agent_task_execution(
      v_cancel_task,v_cancel_target,'worker-cancel'
    );
  exception when others then
    if position('AGENT_TASK_CLAIM_LOST' in sqlerrm)>0 then
      v_cancel_blocked := true;
    else
      raise;
    end if;
  end;

  if not v_cancel_blocked then
    raise exception 'cancelled task created a new run';
  end if;

  insert into public.ai_agent_tasks (
    id,account_id,task_type,task_type_version,agent_id,agent_revision_id,
    trigger_type,status,objective,channel,max_targets,max_attempts_per_target,
    idempotency_key,correlation_id,created_by,available_at
  ) values (
    v_recovery_task,v_account,'coverage.sourcing',1,v_agent,v_revision,
    'manual','queued','Lease recovery smoke','whatsapp',1,2,
    'task-orchestrator-recovery-110',
    'task-orchestrator-recovery-correlation-110',v_user,
    now()-interval '1 second'
  );

  insert into public.ai_agent_task_targets (
    id,account_id,task_id,contact_id,counterparty_role,status,
    conversation_id,idempotency_key
  ) values (
    v_recovery_target,v_account,v_recovery_task,v_contact_2,'supplier',
    'queued',v_conv_2,'task-orchestrator-recovery-target-110'
  );

  v_claim := public.claim_next_agent_task('worker-recovery',120);
  if v_claim <> v_recovery_task then
    raise exception 'recovery task claim failed';
  end if;

  v_target_claim := public.claim_next_agent_task_target(
    v_recovery_task,'worker-recovery',120
  );
  if v_target_claim <> v_recovery_target then
    raise exception 'recovery target claim failed';
  end if;

  update public.ai_agent_tasks
  set lease_expires_at=now()-interval '1 second'
  where id=v_recovery_task;

  update public.ai_agent_task_targets
  set lease_expires_at=now()-interval '1 second'
  where id=v_recovery_target;

  v_sweep := public.sweep_agent_task_claims(now());

  if coalesce((v_sweep->>'tasks_recovered')::int,0)<1
     or coalesce((v_sweep->>'targets_requeued')::int,0)<1 then
    raise exception 'expired lease recovery failed: %',v_sweep;
  end if;

  if exists (
    select 1
    from public.ai_agent_tasks
    where id=v_recovery_task
      and claimed_by is not null
  ) or exists (
    select 1
    from public.ai_agent_task_targets
    where id=v_recovery_target
      and status<>'queued'
  ) then
    raise exception 'recovered claims did not return to durable queue';
  end if;

  if has_function_privilege(
       'anon','public.claim_next_agent_task(text,integer)','EXECUTE'
     )
     or has_function_privilege(
       'authenticated','public.claim_next_agent_task(text,integer)','EXECUTE'
     )
     or not has_function_privilege(
       'service_role','public.claim_next_agent_task(text,integer)','EXECUTE'
     ) then
    raise exception 'claim_next_agent_task privileges unsafe';
  end if;

  if has_function_privilege(
       'anon',
       'public.create_claimed_agent_task_execution(uuid,uuid,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.create_claimed_agent_task_execution(uuid,uuid,text)',
       'EXECUTE'
     ) then
    raise exception 'task execution RPC is publicly executable';
  end if;

  delete from public.ai_agent_task_events where account_id=v_account;
  delete from public.ai_agent_runs
    where account_id=v_account and task_id is not null;
  delete from public.ai_agent_task_targets where account_id=v_account;
  delete from public.ai_agent_tasks where account_id=v_account;
  delete from public.ai_agent_revisions where account_id=v_account;
  delete from public.ai_agents where account_id=v_account;
  delete from public.ai_provider_connections where account_id=v_account;
  delete from public.conversations where account_id=v_account;
  delete from public.contacts where account_id=v_account;
  delete from public.profiles where user_id=v_user;
  delete from public.accounts where id=v_account;
  delete from auth.users where id=v_user;

  raise notice 'agent task orchestrator smoke passed';
end
$$;
