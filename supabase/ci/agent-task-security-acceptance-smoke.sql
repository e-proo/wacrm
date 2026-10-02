begin;

do $$
declare
  v_user uuid;
  v_account_a uuid;
  v_account_b uuid := gen_random_uuid();
  v_connection uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid();
  v_contact_a1 uuid := gen_random_uuid();
  v_contact_a2 uuid := gen_random_uuid();
  v_target uuid;
  v_conversation uuid;
  v_run uuid;
  v_result jsonb;
  v_count bigint;
  v_cross_target_blocked boolean := false;
  v_cross_outcome_blocked boolean := false;
  v_channel_blocked boolean := false;
  v_target_fn text;
  v_constraint text;
begin
  select profile.user_id,profile.account_id
    into strict v_user,v_account_a
  from public.profiles as profile
  order by profile.created_at asc
  limit 1;

  insert into public.ai_provider_connections(
    id,account_id,name,preset_id,protocol,api_root,
    encrypted_api_key,connection_fingerprint,status
  ) values (
    v_connection,v_account_a,
    'Security Provider '||substr(v_connection::text,1,8),
    'security-acceptance','openai','https://example.test/v1',
    'encrypted-security-key',
    'security-'||v_connection::text,'verified'
  );

  insert into public.ai_agents(
    id,account_id,slug,name,purpose,status
  ) values (
    v_agent,v_account_a,
    'security-'||substr(v_agent::text,1,8),
    'Security Agent','custom','active'
  );

  insert into public.ai_agent_revisions(
    id,account_id,agent_id,revision_number,status,
    provider_connection_id,model
  ) values (
    v_revision,v_account_a,v_agent,1,'published',
    v_connection,'security-model'
  );

  update public.ai_agents
  set published_revision_id=v_revision
  where id=v_agent;

  insert into public.contacts(
    id,user_id,account_id,phone,name
  ) values
    (
      v_contact_a1,v_user,v_account_a,
      '+96771'||right(replace(v_contact_a1::text,'-',''),7),
      'Security A1'
    ),
    (
      v_contact_a2,v_user,v_account_a,
      '+96772'||right(replace(v_contact_a2::text,'-',''),7),
      'Security A2'
    );

  insert into public.ai_agent_tasks(
    id,account_id,task_type,task_type_version,
    agent_id,agent_revision_id,trigger_type,status,
    objective,task_context,target_policy,channel,
    max_targets,max_attempts_per_target,budget_policy,
    idempotency_key,correlation_id,created_by
  ) values (
    v_task,v_account_a,'services.promotion',1,
    v_agent,v_revision,'manual','running',
    'Security acceptance','{}'::jsonb,'{}'::jsonb,'whatsapp',
    1,2,'{}'::jsonb,
    'security-task-'||v_task::text,
    'security-correlation-'||v_task::text,
    v_user
  );

  -- Tenant A may materialize its own contact.
  v_result:=public.materialize_agent_task_contact_target(
    v_task,
    v_contact_a1,
    'service_customer',
    'security.acceptance',
    1,
    '{}'::uuid[],
    '{}'::uuid[],
    100,
    100,
    0,
    'security-target-a1-'||v_task::text
  );

  if coalesce((v_result->>'accepted')::boolean,false)<>true then
    raise exception 'same-tenant target was rejected: %',v_result;
  end if;

  v_target:=(v_result->>'target_id')::uuid;
  v_conversation:=(v_result->>'conversation_id')::uuid;

  -- Retry cannot create a duplicate target.
  v_result:=public.materialize_agent_task_contact_target(
    v_task,
    v_contact_a1,
    'service_customer',
    'security.acceptance',
    1,
    '{}'::uuid[],
    '{}'::uuid[],
    100,
    100,
    0,
    'security-target-a1-retry-'||v_task::text
  );

  if v_result->>'reason'<>'duplicate'
     or (v_result->>'target_id')::uuid<>v_target then
    raise exception 'target retry escaped idempotency: %',v_result;
  end if;

  -- maxTargets cannot be bypassed with a second same-tenant candidate.
  v_result:=public.materialize_agent_task_contact_target(
    v_task,
    v_contact_a2,
    'service_customer',
    'security.acceptance',
    1,
    '{}'::uuid[],
    '{}'::uuid[],
    100,
    100,
    0,
    'security-target-a2-'||v_task::text
  );

  if v_result->>'reason'<>'task_target_limit' then
    raise exception 'Task maxTargets was bypassed: %',v_result;
  end if;

  select count(*) into v_count
  from public.ai_agent_task_targets
  where account_id=v_account_a
    and task_id=v_task;

  if v_count<>1 then
    raise exception 'Task target count is not bounded: %',v_count;
  end if;

  -- Direct insertion cannot bypass composite tenant FKs.
  begin
    insert into public.ai_agent_task_targets(
      account_id,task_id,contact_id,counterparty_role,status,idempotency_key
    ) values (
      v_account_b,v_task,v_contact_a1,'service_customer',
      'eligible','security-direct-cross-'||v_task::text
    );
  exception
    when foreign_key_violation then
      v_cross_target_blocked:=true;
    when others then
      if position('AGENT_TASK_NOT_FOUND' in upper(sqlerrm))>0 then
        v_cross_target_blocked:=true;
      else
        raise;
      end if;
  end;

  if not v_cross_target_blocked then
    raise exception 'Cross-tenant direct target insert was not blocked';
  end if;

  -- V1 channel scope is a DB contract, not prompt guidance.
  begin
    insert into public.ai_agent_tasks(
      account_id,task_type,task_type_version,
      agent_id,agent_revision_id,trigger_type,status,
      objective,channel,max_targets,max_attempts_per_target,
      idempotency_key,correlation_id
    ) values (
      v_account_a,'services.promotion',1,
      v_agent,v_revision,'manual','running',
      'Channel escalation test','email',1,1,
      'security-email-'||v_task::text,
      'security-email-correlation-'||v_task::text
    );
  exception
    when check_violation then
      v_channel_blocked:=true;
  end;

  if not v_channel_blocked then
    raise exception 'Non-WhatsApp channel escaped V1 DB contract';
  end if;

  v_run:=public.create_agent_execution(
    v_account_a,v_conversation,null,
    v_agent,v_revision,v_connection,
    null,'security acceptance','customer','outbound',
    v_task,v_target,'task_target','attempt:1','service_customer',
    'security-run-'||v_task::text
  );

  -- Wrong account cannot claim a Run as its business outcome source.
  begin
    perform public.link_ai_agent_business_outcome(
      v_account_b,v_run,'customer_intent',gen_random_uuid()::text,'new'
    );
  exception when others then
    if position('AI_BUSINESS_OUTCOME_RUN_NOT_FOUND' in upper(sqlerrm))>0 then
      v_cross_outcome_blocked:=true;
    else
      raise;
    end if;
  end;

  if not v_cross_outcome_blocked then
    raise exception 'Cross-tenant business outcome link was not blocked';
  end if;

  -- Account-scoped trace cannot discover another tenant's Task.
  if public.inspect_ai_agent_task_trace(v_account_b,v_task) is not null then
    raise exception 'Cross-tenant Task trace leaked another account';
  end if;

  -- Tenant isolation is structurally composite at the durable target boundary.
  select pg_get_constraintdef(oid)
    into v_constraint
  from pg_constraint
  where conrelid='public.ai_agent_task_targets'::regclass
    and conname='ai_agent_task_targets_account_contact_fk';

  if position('FOREIGN KEY (account_id, contact_id)' in v_constraint)=0 then
    raise exception 'Target contact FK is not tenant-composite: %',v_constraint;
  end if;

  select pg_get_functiondef(
    'public.materialize_agent_task_contact_target(uuid,uuid,text,text,integer,uuid[],uuid[],integer,integer,integer,text)'::regprocedure
  ) into v_target_fn;

  if position('ACCOUNT_ID=V_TASK.ACCOUNT_ID' in
      replace(upper(v_target_fn),' ',''))=0 then
    raise exception 'Target resolver does not scope Contact by Task account';
  end if;

  select pg_get_functiondef(
    'public.enforce_change_request_source_run_tenant()'::regprocedure
  ) into v_target_fn;

  if position('RUN.ACCOUNT_ID=NEW.ACCOUNT_ID' in
      replace(upper(v_target_fn),' ',''))=0 then
    raise exception 'Change Request source-run tenant guard is incomplete';
  end if;

  -- Concurrency protections must exist at the durable target boundary:
  -- same-Task serialization plus account-wide insert serialization.
  select pg_get_functiondef(
    'public.materialize_agent_task_contact_target(uuid,uuid,text,text,integer,uuid[],uuid[],integer,integer,integer,text)'::regprocedure
  ) into v_target_fn;

  if position('FOR UPDATE' in upper(v_target_fn))=0 then
    raise exception 'Task target materialization lacks row-lock serialization';
  end if;

  select pg_get_functiondef(
    'public.enforce_ai_agent_task_target_scope_guard()'::regprocedure
  ) into v_target_fn;

  if position('PG_ADVISORY_XACT_LOCK' in upper(v_target_fn))=0
     or position('AGENT_TASK_TARGET_LIMIT_EXCEEDED' in upper(v_target_fn))=0
     or position('AGENT_ACCOUNT_HOURLY_TARGET_LIMIT_EXCEEDED' in upper(v_target_fn))=0
     or position('AGENT_DAILY_TARGET_LIMIT_EXCEEDED' in upper(v_target_fn))=0 then
    raise exception 'Target concurrency guard is incomplete';
  end if;

  if has_function_privilege(
       'anon',
       'public.create_customer_intent(uuid,uuid,uuid,text,text,text,jsonb,text,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.create_customer_intent(uuid,uuid,uuid,text,text,text,jsonb,text,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.claim_ai_reply_slot(uuid,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.claim_ai_reply_slot(uuid,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.create_change_request(uuid,text,uuid,text,jsonb,bigint,text,text,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.create_change_request(uuid,text,uuid,text,jsonb,bigint,text,text,uuid)',
       'EXECUTE'
     ) then
    raise exception 'Client role can execute a server-only/legacy Agent mutation RPC';
  end if;

  if has_function_privilege(
       'anon',
       'public.publish_ai_agent_revision_atomic(uuid,uuid,uuid,bigint,uuid)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'authenticated',
       'public.publish_ai_agent_revision_atomic(uuid,uuid,uuid,bigint,uuid)',
       'EXECUTE'
     ) then
    raise exception 'Authenticated Agent publish surface is misconfigured';
  end if;

  raise notice 'Agent Task security acceptance smoke passed';
end
$$;

rollback;
