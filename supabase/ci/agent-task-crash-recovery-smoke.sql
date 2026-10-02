begin;

do $$
declare
  v_user uuid;
  v_account uuid;
  v_connection uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid();

  v_contact_safe uuid := gen_random_uuid();
  v_contact_ambiguous uuid := gen_random_uuid();
  v_conv_safe uuid := gen_random_uuid();
  v_conv_ambiguous uuid := gen_random_uuid();
  v_target_safe uuid := gen_random_uuid();
  v_target_ambiguous uuid := gen_random_uuid();

  v_run_safe uuid;
  v_run_retry uuid;
  v_run_ambiguous uuid;
  v_reservation_safe uuid;
  v_reservation_retry uuid;
  v_reservation_ambiguous uuid;
  v_local_message uuid := gen_random_uuid();
  v_result jsonb;
  v_sweep jsonb;
begin
  select profile.user_id,profile.account_id
    into strict v_user,v_account
  from public.profiles as profile
  order by profile.created_at asc
  limit 1;

  insert into public.ai_provider_connections(
    id,account_id,name,preset_id,protocol,api_root,
    encrypted_api_key,connection_fingerprint,status
  ) values (
    v_connection,v_account,
    'Phase17 Recovery '||substr(v_connection::text,1,8),
    'phase17-recovery','openai','https://example.test/v1',
    'encrypted-phase17-recovery',
    'phase17-recovery-'||v_connection::text,'verified'
  );

  insert into public.ai_agents(
    id,account_id,slug,name,purpose,status
  ) values (
    v_agent,v_account,
    'phase17-recovery-'||substr(v_agent::text,1,8),
    'Phase 17 Recovery Agent','custom','active'
  );

  insert into public.ai_agent_revisions(
    id,account_id,agent_id,revision_number,status,
    provider_connection_id,model
  ) values (
    v_revision,v_account,v_agent,1,'published',
    v_connection,'phase17-recovery-model'
  );

  update public.ai_agents
  set published_revision_id=v_revision
  where id=v_agent;

  insert into public.contacts(
    id,user_id,account_id,phone,name
  ) values
    (
      v_contact_safe,v_user,v_account,
      '+96775'||right(replace(v_contact_safe::text,'-',''),7),
      'Phase 17 Recovery Safe'
    ),
    (
      v_contact_ambiguous,v_user,v_account,
      '+96776'||right(replace(v_contact_ambiguous::text,'-',''),7),
      'Phase 17 Recovery Ambiguous'
    );

  insert into public.conversations(
    id,user_id,account_id,contact_id,status
  ) values
    (v_conv_safe,v_user,v_account,v_contact_safe,'open'),
    (v_conv_ambiguous,v_user,v_account,v_contact_ambiguous,'open');

  insert into public.messages(
    conversation_id,sender_type,content_type,content_text,status,created_at
  ) values
    (
      v_conv_safe,'customer','text',
      'Recovery safe recent inbound','sent',now()
    ),
    (
      v_conv_ambiguous,'customer','text',
      'Recovery ambiguous recent inbound','sent',now()
    );

  insert into public.ai_runtime_policies(
    account_id,multi_agent_enabled,recovery_worker_enabled,
    outbound_task_delivery_enabled,kill_switch,max_runs_per_minute,updated_by
  ) values (
    v_account,true,true,true,false,100,v_user
  )
  on conflict (account_id) do update set
    multi_agent_enabled=true,
    recovery_worker_enabled=true,
    outbound_task_delivery_enabled=true,
    kill_switch=false,
    max_runs_per_minute=100,
    updated_by=v_user;

  insert into public.ai_agent_tasks(
    id,account_id,task_type,task_type_version,
    agent_id,agent_revision_id,trigger_type,status,
    objective,task_context,target_policy,channel,
    max_targets,max_attempts_per_target,budget_policy,
    idempotency_key,correlation_id,created_by,started_at
  ) values (
    v_task,v_account,'services.promotion',1,
    v_agent,v_revision,'manual','running',
    'Phase 17 crash recovery',
    '{}'::jsonb,'{}'::jsonb,'whatsapp',
    5,4,'{}'::jsonb,
    'phase17-recovery-task-'||v_task::text,
    'phase17-recovery-correlation-'||v_task::text,
    v_user,now()
  );

  insert into public.ai_agent_task_targets(
    id,account_id,task_id,contact_id,counterparty_role,status,
    conversation_id,attempt_count,idempotency_key
  ) values
    (
      v_target_safe,v_account,v_task,v_contact_safe,
      'service_customer','in_progress',v_conv_safe,1,
      'phase17-recovery-target-safe-'||v_target_safe::text
    ),
    (
      v_target_ambiguous,v_account,v_task,v_contact_ambiguous,
      'service_customer','in_progress',v_conv_ambiguous,1,
      'phase17-recovery-target-ambiguous-'||v_target_ambiguous::text
    );

  -- Crash after the worker has claimed the Agent Run (model/tool phase).
  v_run_safe:=public.create_agent_execution(
    v_account,v_conv_safe,null,
    v_agent,v_revision,v_connection,
    null,'phase17 recovery safe','customer','outbound',
    v_task,v_target_safe,'task_target','attempt:1','service_customer',
    'phase17-recovery-safe-run-'||v_task::text
  );

  if public.claim_agent_run(v_run_safe,'phase17-worker-a',30)<>'claimed' then
    raise exception 'Initial run claim failed';
  end if;

  insert into public.ai_agent_tool_call_attempts(
    account_id,run_id,agent_id,revision_id,
    tool_key,tool_version,round,permission,status,
    input_hash,duration_ms
  ) values (
    v_account,v_run_safe,v_agent,v_revision,
    'services.get',1,1,'read','succeeded',
    encode(digest('phase17-recovery-tool','sha256'),'hex'),9
  );

  update public.ai_agent_runs
  set lease_expires_at=now()-interval '1 second'
  where id=v_run_safe;

  if public.claim_agent_run(v_run_safe,'phase17-worker-b',300)<>'claimed' then
    raise exception 'Expired run lease was not recoverable';
  end if;

  if not exists (
    select 1
    from public.ai_agent_runs
    where id=v_run_safe
      and claimed_by='phase17-worker-b'
      and attempt_count=2
  ) then
    raise exception 'Recovered run did not preserve identity/attempt count';
  end if;

  -- Re-creating the exact execution after a crash must resolve to the same Run.
  v_run_retry:=public.create_agent_execution(
    v_account,v_conv_safe,null,
    v_agent,v_revision,v_connection,
    null,'phase17 recovery replay','customer','outbound',
    v_task,v_target_safe,'task_target','attempt:1','service_customer',
    'phase17-recovery-safe-run-'||v_task::text
  );

  if v_run_retry<>v_run_safe
     or (
       select count(*)
       from public.ai_agent_runs
       where account_id=v_account
         and idempotency_key='phase17-recovery-safe-run-'||v_task::text
     )<>1 then
    raise exception 'Agent Run replay created a duplicate';
  end if;

  -- Reservation crash before transport ownership is replay-safe.
  v_result:=public.reserve_agent_task_outbound_message(
    v_run_safe,
    'services.promotion_message',1,'text',
    'Recovery-safe outbound message.',
    null,null,'[]'::jsonb,
    2,60,1440,true
  );

  if coalesce((v_result->>'reserved')::boolean,false)<>true then
    raise exception 'Safe reservation failed: %',v_result;
  end if;
  v_reservation_safe:=(v_result->>'reservation_id')::uuid;

  v_result:=public.reserve_agent_task_outbound_message(
    v_run_safe,
    'services.promotion_message',1,'text',
    'A replay must not create a new reservation.',
    null,null,'[]'::jsonb,
    2,60,1440,true
  );

  v_reservation_retry:=(v_result->>'reservation_id')::uuid;
  if v_result->>'reason'<>'existing'
     or v_reservation_retry<>v_reservation_safe
     or (
       select count(*)
       from public.ai_agent_task_outbound_messages
       where account_id=v_account
         and run_id=v_run_safe
     )<>1 then
    raise exception 'Reservation replay created a duplicate: %',v_result;
  end if;

  v_result:=public.claim_agent_task_outbound_message(
    v_reservation_safe,'phase17-transport-safe',120
  );
  if coalesce((v_result->>'claimed')::boolean,false)<>true then
    raise exception 'Safe transport claim failed: %',v_result;
  end if;

  insert into public.messages(
    id,conversation_id,sender_type,content_type,content_text,
    message_id,status,ai_generated,ai_agent_run_id
  ) values (
    v_local_message,v_conv_safe,'bot','text',
    'Recovery-safe outbound message.',
    'wamid.phase17.recovery.safe','sent',true,v_run_safe
  );

  if not public.complete_agent_task_outbound_message(
    v_reservation_safe,
    'phase17-transport-safe',
    v_local_message,
    'wamid.phase17.recovery.safe',
    8,
    3
  ) then
    raise exception 'Safe outbound completion failed';
  end if;

  v_result:=public.claim_agent_task_outbound_message(
    v_reservation_safe,'phase17-transport-retry',120
  );
  if v_result->>'reason'<>'already_sent' then
    raise exception 'Completed message was reclaimable: %',v_result;
  end if;

  -- Crash AFTER transport ownership is deliberately not auto-retried.
  v_run_ambiguous:=public.create_agent_execution(
    v_account,v_conv_ambiguous,null,
    v_agent,v_revision,v_connection,
    null,'phase17 recovery ambiguous','customer','outbound',
    v_task,v_target_ambiguous,'task_target','attempt:1','service_customer',
    'phase17-recovery-ambiguous-run-'||v_task::text
  );

  if public.claim_agent_run(
       v_run_ambiguous,'phase17-worker-ambiguous',300
     )<>'claimed' then
    raise exception 'Ambiguous run claim failed';
  end if;

  v_result:=public.reserve_agent_task_outbound_message(
    v_run_ambiguous,
    'services.promotion_message',1,'text',
    'Potentially ambiguous transport message.',
    null,null,'[]'::jsonb,
    2,60,1440,true
  );
  if coalesce((v_result->>'reserved')::boolean,false)<>true then
    raise exception 'Ambiguous reservation setup failed: %',v_result;
  end if;
  v_reservation_ambiguous:=(v_result->>'reservation_id')::uuid;

  v_result:=public.claim_agent_task_outbound_message(
    v_reservation_ambiguous,'phase17-transport-ambiguous',30
  );
  if coalesce((v_result->>'claimed')::boolean,false)<>true then
    raise exception 'Ambiguous transport ownership failed: %',v_result;
  end if;

  update public.ai_agent_task_outbound_messages
  set lease_expires_at=now()-interval '1 second'
  where id=v_reservation_ambiguous;

  v_sweep:=public.sweep_agent_task_outbound_messages(now());

  if coalesce((v_sweep->>'requires_reconciliation')::integer,0)<1
     or not exists (
       select 1
       from public.ai_agent_task_outbound_messages
       where id=v_reservation_ambiguous
         and status='requires_reconciliation'
         and claimed_by is null
     )
     or not exists (
       select 1
       from public.ai_agent_runs
       where id=v_run_ambiguous
         and status='failed'
         and error_code='OUTBOUND_REQUIRES_RECONCILIATION'
     ) then
    raise exception 'Ambiguous transport crash was not quarantined: %',v_sweep;
  end if;

  v_result:=public.claim_agent_task_outbound_message(
    v_reservation_ambiguous,'phase17-transport-unsafe-retry',120
  );
  if v_result->>'reason'<>'reconciliation_required' then
    raise exception 'Ambiguous send was blindly reclaimable: %',v_result;
  end if;

  raise notice 'Agent Task Phase 17 crash recovery smoke passed';
end
$$;

rollback;
