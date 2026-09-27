do $$
declare
  v_user_a uuid := '00000000-0000-4000-8000-000000000111';
  v_user_b uuid := '00000000-0000-4000-8000-000000000211';
  v_account_a uuid;
  v_account_b uuid;
  v_contact_ok uuid := gen_random_uuid();
  v_contact_suppressed uuid := gen_random_uuid();
  v_contact_invalid uuid := gen_random_uuid();
  v_contact_missing_tag uuid := gen_random_uuid();
  v_contact_excluded uuid := gen_random_uuid();
  v_contact_limit uuid := gen_random_uuid();
  v_contact_other uuid := gen_random_uuid();
  v_tag_required uuid := gen_random_uuid();
  v_tag_excluded uuid := gen_random_uuid();
  v_connection uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid();
  v_task_cooldown uuid := gen_random_uuid();
  v_task_limit uuid := gen_random_uuid();
  v_result jsonb;
  v_first_target uuid;
begin
  insert into auth.users (id,email,raw_user_meta_data)
  values
    (v_user_a,'target-resolution-a@example.test','{"full_name":"Target A"}'::jsonb),
    (v_user_b,'target-resolution-b@example.test','{"full_name":"Target B"}'::jsonb);

  select account_id into strict v_account_a from public.profiles where user_id=v_user_a;
  select account_id into strict v_account_b from public.profiles where user_id=v_user_b;

  insert into public.contacts (id,user_id,account_id,phone,name)
  values
    (v_contact_ok,v_user_a,v_account_a,'+967700000111','Eligible'),
    (v_contact_suppressed,v_user_a,v_account_a,'+967700000112','Suppressed'),
    (v_contact_invalid,v_user_a,v_account_a,'12','Invalid Channel'),
    (v_contact_missing_tag,v_user_a,v_account_a,'+967700000113','Missing Tag'),
    (v_contact_excluded,v_user_a,v_account_a,'+967700000114','Excluded'),
    (v_contact_limit,v_user_a,v_account_a,'+967700000115','Limit Candidate'),
    (v_contact_other,v_user_b,v_account_b,'+967700000211','Other Account');

  insert into public.tags (id,user_id,account_id,name,color)
  values
    (v_tag_required,v_user_a,v_account_a,'supplier','#111111'),
    (v_tag_excluded,v_user_a,v_account_a,'do-not-source','#222222');

  insert into public.contact_tags (contact_id,tag_id)
  values
    (v_contact_ok,v_tag_required),
    (v_contact_suppressed,v_tag_required),
    (v_contact_excluded,v_tag_required),
    (v_contact_excluded,v_tag_excluded),
    (v_contact_limit,v_tag_required);

  insert into public.ai_provider_connections (
    id,account_id,name,preset_id,protocol,api_root,
    encrypted_api_key,connection_fingerprint,status
  ) values (
    v_connection,v_account_a,'Eligibility Provider','eligibility-smoke',
    'openai','https://example.test/v1','encrypted-key',
    'eligibility-smoke-111','verified'
  );

  insert into public.ai_agents (id,account_id,slug,name,purpose,status)
  values (
    v_agent,v_account_a,'eligibility-agent','Eligibility Agent','custom','active'
  );

  insert into public.ai_agent_revisions (
    id,account_id,agent_id,revision_number,status,provider_connection_id,model
  ) values (
    v_revision,v_account_a,v_agent,1,'published',v_connection,'smoke-model'
  );

  insert into public.ai_agent_tasks (
    id,account_id,task_type,task_type_version,agent_id,agent_revision_id,
    trigger_type,status,objective,channel,max_targets,max_attempts_per_target,
    idempotency_key,correlation_id,created_by
  ) values (
    v_task,v_account_a,'coverage.sourcing',1,v_agent,v_revision,
    'manual','queued','Eligibility smoke','whatsapp',10,2,
    'eligibility-task-111','eligibility-task-correlation-111',v_user_a
  );

  insert into public.ai_outreach_contact_controls (
    account_id,contact_id,channel,state,reason,source,created_by
  ) values (
    v_account_a,v_contact_suppressed,'whatsapp','opted_out',
    'smoke opt-out','test',v_user_a
  );

  v_result:=public.materialize_agent_task_contact_target(
    v_task,v_contact_suppressed,'supplier','coverage.supplier_candidates',1,
    array[v_tag_required]::uuid[],'{}'::uuid[],100,100,0,
    'eligibility-suppressed-111'
  );
  if v_result->>'reason'<>'suppressed' then
    raise exception 'suppression was not enforced: %',v_result;
  end if;

  v_result:=public.materialize_agent_task_contact_target(
    v_task,v_contact_invalid,'supplier','coverage.supplier_candidates',1,
    '{}'::uuid[],'{}'::uuid[],100,100,0,'eligibility-invalid-111'
  );
  if v_result->>'reason'<>'channel_unavailable' then
    raise exception 'invalid channel was not rejected: %',v_result;
  end if;

  v_result:=public.materialize_agent_task_contact_target(
    v_task,v_contact_missing_tag,'supplier','coverage.supplier_candidates',1,
    array[v_tag_required]::uuid[],'{}'::uuid[],100,100,0,
    'eligibility-missing-tag-111'
  );
  if v_result->>'reason'<>'required_segment_missing' then
    raise exception 'required segment was not enforced: %',v_result;
  end if;

  v_result:=public.materialize_agent_task_contact_target(
    v_task,v_contact_excluded,'supplier','coverage.supplier_candidates',1,
    array[v_tag_required]::uuid[],array[v_tag_excluded]::uuid[],100,100,0,
    'eligibility-excluded-111'
  );
  if v_result->>'reason'<>'excluded_segment' then
    raise exception 'excluded segment was not enforced: %',v_result;
  end if;

  v_result:=public.materialize_agent_task_contact_target(
    v_task,v_contact_other,'supplier','coverage.supplier_candidates',1,
    '{}'::uuid[],'{}'::uuid[],100,100,0,'eligibility-cross-account-111'
  );
  if v_result->>'reason'<>'contact_not_found' then
    raise exception 'cross-account contact was not rejected: %',v_result;
  end if;

  v_result:=public.materialize_agent_task_contact_target(
    v_task,v_contact_ok,'supplier','coverage.supplier_candidates',1,
    array[v_tag_required]::uuid[],'{}'::uuid[],100,100,0,
    'eligibility-ok-111'
  );
  if coalesce((v_result->>'accepted')::boolean,false)<>true then
    raise exception 'eligible target was rejected: %',v_result;
  end if;
  v_first_target:=(v_result->>'target_id')::uuid;

  if not exists (
    select 1 from public.ai_agent_task_targets
    where id=v_first_target
      and counterparty_role='supplier'
      and resolver_key='coverage.supplier_candidates'
      and resolver_version=1
      and status='eligible'
      and conversation_id is not null
      and eligibility_snapshot->>'channel'='whatsapp'
  ) then
    raise exception 'eligible target audit snapshot is incomplete';
  end if;

  v_result:=public.materialize_agent_task_contact_target(
    v_task,v_contact_ok,'supplier','coverage.supplier_candidates',1,
    array[v_tag_required]::uuid[],'{}'::uuid[],100,100,0,
    'eligibility-duplicate-other-key-111'
  );
  if v_result->>'reason'<>'duplicate'
     or (v_result->>'target_id')::uuid<>v_first_target then
    raise exception 'duplicate target was not idempotently rejected: %',v_result;
  end if;

  insert into public.ai_agent_tasks (
    id,account_id,task_type,task_type_version,agent_id,agent_revision_id,
    trigger_type,status,objective,channel,max_targets,max_attempts_per_target,
    idempotency_key,correlation_id,created_by
  ) values (
    v_task_cooldown,v_account_a,'coverage.sourcing',1,v_agent,v_revision,
    'manual','queued','Cooldown smoke','whatsapp',10,2,
    'eligibility-cooldown-task-111','eligibility-cooldown-correlation-111',v_user_a
  );

  v_result:=public.materialize_agent_task_contact_target(
    v_task_cooldown,v_contact_ok,'supplier','coverage.supplier_candidates',1,
    array[v_tag_required]::uuid[],'{}'::uuid[],100,100,60,
    'eligibility-cooldown-111'
  );
  if v_result->>'reason'<>'contact_cooldown' then
    raise exception 'contact cooldown was not enforced: %',v_result;
  end if;

  v_result:=public.materialize_agent_task_contact_target(
    v_task_cooldown,v_contact_limit,'supplier','coverage.supplier_candidates',1,
    array[v_tag_required]::uuid[],'{}'::uuid[],1,100,0,
    'eligibility-hourly-limit-111'
  );
  if v_result->>'reason'<>'account_hourly_contact_limit' then
    raise exception 'hourly account limit was not enforced: %',v_result;
  end if;

  v_result:=public.materialize_agent_task_contact_target(
    v_task_cooldown,v_contact_limit,'supplier','coverage.supplier_candidates',1,
    array[v_tag_required]::uuid[],'{}'::uuid[],100,1,0,
    'eligibility-daily-limit-111'
  );
  if v_result->>'reason'<>'agent_daily_contact_limit' then
    raise exception 'daily agent limit was not enforced: %',v_result;
  end if;

  insert into public.ai_agent_tasks (
    id,account_id,task_type,task_type_version,agent_id,agent_revision_id,
    trigger_type,status,objective,channel,max_targets,max_attempts_per_target,
    idempotency_key,correlation_id,created_by
  ) values (
    v_task_limit,v_account_a,'coverage.sourcing',1,v_agent,v_revision,
    'manual','queued','Task target cap smoke','whatsapp',1,2,
    'eligibility-limit-task-111','eligibility-limit-correlation-111',v_user_a
  );

  v_result:=public.materialize_agent_task_contact_target(
    v_task_limit,v_contact_limit,'supplier','coverage.supplier_candidates',1,
    array[v_tag_required]::uuid[],'{}'::uuid[],100,100,0,
    'eligibility-limit-first-111'
  );
  if coalesce((v_result->>'accepted')::boolean,false)<>true then
    raise exception 'task target cap setup failed: %',v_result;
  end if;

  v_result:=public.materialize_agent_task_contact_target(
    v_task_limit,v_contact_missing_tag,'supplier','coverage.supplier_candidates',1,
    '{}'::uuid[],'{}'::uuid[],100,100,0,'eligibility-limit-second-111'
  );
  if v_result->>'reason'<>'task_target_limit' then
    raise exception 'task target limit was not enforced: %',v_result;
  end if;

  if has_function_privilege(
       'anon',
       'public.materialize_agent_task_contact_target(uuid,uuid,text,text,integer,uuid[],uuid[],integer,integer,integer,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.materialize_agent_task_contact_target(uuid,uuid,text,text,integer,uuid[],uuid[],integer,integer,integer,text)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.materialize_agent_task_contact_target(uuid,uuid,text,text,integer,uuid[],uuid[],integer,integer,integer,text)',
       'EXECUTE'
     ) then
    raise exception 'eligibility RPC privileges are unsafe';
  end if;

  if not exists (
    select 1 from pg_class
    where oid='public.ai_outreach_contact_controls'::regclass
      and relrowsecurity
  ) then
    raise exception 'outreach contact controls RLS is disabled';
  end if;

  delete from public.ai_agent_task_events where account_id=v_account_a;
  delete from public.ai_agent_runs where account_id=v_account_a and task_id is not null;
  delete from public.ai_agent_task_targets where account_id=v_account_a;
  delete from public.ai_agent_tasks where account_id=v_account_a;
  delete from public.ai_outreach_contact_controls where account_id=v_account_a;
  delete from public.contact_tags where contact_id in (
    v_contact_ok,v_contact_suppressed,v_contact_excluded,v_contact_limit
  );
  delete from public.tags where account_id=v_account_a;
  delete from public.ai_agent_revisions where account_id=v_account_a;
  delete from public.ai_agents where account_id=v_account_a;
  delete from public.ai_provider_connections where account_id=v_account_a;
  delete from public.conversations where account_id in (v_account_a,v_account_b);
  delete from public.contacts where account_id in (v_account_a,v_account_b);
  delete from public.profiles where user_id in (v_user_a,v_user_b);
  delete from public.accounts where id in (v_account_a,v_account_b);
  delete from auth.users where id in (v_user_a,v_user_b);

  raise notice 'agent target resolution eligibility smoke passed';
end
$$;
