do $$
declare
  v_user uuid := '00000000-0000-4000-8000-000000000114';
  v_account uuid;
  v_connection uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_contact uuid := gen_random_uuid();
  v_conversation uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid();
  v_target uuid := gen_random_uuid();
  v_count integer;
  v_failed boolean;
begin
  insert into auth.users(id,email,raw_user_meta_data)
  values (
    v_user,
    'agent-outbound-capabilities-smoke@example.test',
    '{"full_name":"Agent Outbound Capabilities Smoke"}'::jsonb
  );

  select account_id into strict v_account
  from public.profiles
  where user_id=v_user;

  insert into public.contacts(id,user_id,account_id,phone,name)
  values (
    v_contact,v_user,v_account,'+967700000114','Capability Target'
  );

  insert into public.conversations(id,user_id,account_id,contact_id)
  values (
    v_conversation,v_user,v_account,v_contact
  );

  insert into public.ai_provider_connections(
    id,account_id,name,preset_id,protocol,api_root,
    encrypted_api_key,connection_fingerprint,status
  ) values (
    v_connection,v_account,'Capability Provider','capability-smoke',
    'openai','https://example.test/v1','encrypted-smoke-key',
    'capability-smoke-114','verified'
  );

  insert into public.ai_agents(
    id,account_id,slug,name,purpose,status
  ) values (
    v_agent,v_account,'outbound-capability-agent',
    'Outbound Capability Agent','custom','active'
  );

  insert into public.ai_agent_revisions(
    id,account_id,agent_id,revision_number,status,
    provider_connection_id,model
  ) values (
    v_revision,v_account,v_agent,1,'draft',
    v_connection,'smoke-model'
  );

  v_count:=public.replace_ai_agent_revision_capabilities(
    v_account,
    v_agent,
    v_revision,
    '[
      "agent_tasks.read",
      "outreach.start",
      "contacts.target_read",
      "coverage.sourcing",
      "coverage.read",
      "coverage.read"
    ]'::jsonb,
    v_user
  );

  if v_count<>5 then
    raise exception 'capability replace did not deduplicate: %',v_count;
  end if;

  if (
    select count(*)
    from public.ai_agent_revision_capabilities
    where account_id=v_account
      and agent_revision_id=v_revision
  )<>5 then
    raise exception 'unexpected frozen capability row count';
  end if;

  begin
    perform public.replace_ai_agent_revision_capabilities(
      v_account,
      v_agent,
      v_revision,
      '["bad capability"]'::jsonb,
      v_user
    );
    raise exception 'invalid capability unexpectedly accepted';
  exception
    when others then
      if sqlerrm not like 'AGENT_CAPABILITY_INVALID:%' then
        raise;
      end if;
  end;

  update public.ai_agent_revisions
  set status='published'
  where id=v_revision;

  begin
    perform public.replace_ai_agent_revision_capabilities(
      v_account,
      v_agent,
      v_revision,
      '["agent_tasks.read"]'::jsonb,
      v_user
    );
    raise exception 'published revision capability mutation unexpectedly accepted';
  exception
    when others then
      if sqlerrm<>'AGENT_CAPABILITIES_REVISION_NOT_DRAFT' then
        raise;
      end if;
  end;

  insert into public.ai_agent_tasks(
    id,account_id,task_type,task_type_version,
    agent_id,agent_revision_id,trigger_type,status,
    objective,channel,max_targets,max_attempts_per_target,
    idempotency_key,correlation_id,created_by,
    available_at,claimed_by,lease_expires_at
  ) values (
    v_task,v_account,'coverage.sourcing',1,
    v_agent,v_revision,'manual','running',
    'Capability policy failure smoke','whatsapp',1,2,
    'capability-task-114','capability-correlation-114',v_user,
    now(),'capability-worker',now()+interval '2 minutes'
  );

  insert into public.ai_agent_task_targets(
    id,account_id,task_id,contact_id,counterparty_role,
    status,conversation_id,attempt_count,idempotency_key,
    available_at
  ) values (
    v_target,v_account,v_task,v_contact,'supplier',
    'queued',v_conversation,0,'capability-target-114',now()
  );

  v_failed:=public.fail_claimed_agent_task_policy(
    v_task,
    'capability-worker',
    'AGENT_CAPABILITY_MISSING'
  );

  if v_failed is distinct from true then
    raise exception 'task policy failure transition returned false';
  end if;

  if not exists (
    select 1
    from public.ai_agent_tasks
    where id=v_task
      and status='failed'
      and completed_at is not null
      and claimed_by is null
      and lease_expires_at is null
  ) then
    raise exception 'task policy failure did not fail the task';
  end if;

  if not exists (
    select 1
    from public.ai_agent_task_targets
    where id=v_target
      and status='failed'
      and failure_code='AGENT_CAPABILITY_MISSING'
      and claimed_by is null
      and lease_expires_at is null
  ) then
    raise exception 'task policy failure did not fail active targets';
  end if;

  if not exists (
    select 1
    from public.ai_agent_task_events
    where task_id=v_task
      and event_type='task.policy_failed'
      and payload->>'error_code'='AGENT_CAPABILITY_MISSING'
  ) then
    raise exception 'task policy failure audit event missing';
  end if;

  if not exists (
    select 1
    from pg_class
    where oid='public.ai_agent_revision_capabilities'::regclass
      and relrowsecurity
  ) then
    raise exception 'revision capability table RLS is disabled';
  end if;

  if has_function_privilege(
       'anon',
       'public.replace_ai_agent_revision_capabilities(uuid,uuid,uuid,jsonb,uuid)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'authenticated',
       'public.replace_ai_agent_revision_capabilities(uuid,uuid,uuid,jsonb,uuid)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.replace_ai_agent_revision_capabilities(uuid,uuid,uuid,jsonb,uuid)',
       'EXECUTE'
     ) then
    raise exception 'capability replace RPC privileges are unsafe';
  end if;

  if has_function_privilege(
       'anon',
       'public.fail_claimed_agent_task_policy(uuid,text,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.fail_claimed_agent_task_policy(uuid,text,text)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.fail_claimed_agent_task_policy(uuid,text,text)',
       'EXECUTE'
     ) then
    raise exception 'task policy failure RPC privileges are unsafe';
  end if;

  delete from public.ai_agent_task_events where account_id=v_account;
  delete from public.ai_agent_task_targets where account_id=v_account;
  delete from public.ai_agent_tasks where account_id=v_account;
  delete from public.ai_agent_revision_capabilities where account_id=v_account;
  delete from public.ai_agent_revisions where account_id=v_account;
  delete from public.ai_agents where account_id=v_account;
  delete from public.ai_provider_connections where account_id=v_account;
  delete from public.conversations where account_id=v_account;
  delete from public.contacts where account_id=v_account;
  delete from public.profiles where user_id=v_user;
  delete from public.accounts where id=v_account;
  delete from auth.users where id=v_user;

  raise notice 'agent outbound capabilities smoke passed';
end
$$;
