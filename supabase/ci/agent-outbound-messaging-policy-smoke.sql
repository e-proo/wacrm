do $$
declare
  v_user uuid := '00000000-0000-4000-8000-000000000112';
  v_account uuid;
  v_connection uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid();

  v_contact_active uuid := gen_random_uuid();
  v_contact_cold uuid := gen_random_uuid();
  v_contact_stale uuid := gen_random_uuid();
  v_contact_suppressed uuid := gen_random_uuid();
  v_contact_success uuid := gen_random_uuid();

  v_conv_active uuid := gen_random_uuid();
  v_conv_cold uuid := gen_random_uuid();
  v_conv_stale uuid := gen_random_uuid();
  v_conv_suppressed uuid := gen_random_uuid();
  v_conv_success uuid := gen_random_uuid();

  v_target_active uuid := gen_random_uuid();
  v_target_cold uuid := gen_random_uuid();
  v_target_stale uuid := gen_random_uuid();
  v_target_suppressed uuid := gen_random_uuid();
  v_target_success uuid := gen_random_uuid();

  v_run_active uuid;
  v_run_cold uuid;
  v_run_stale uuid;
  v_run_suppressed uuid;
  v_run_success uuid;

  v_result jsonb;
  v_sweep jsonb;
  v_reservation_active uuid;
  v_reservation_stale uuid;
  v_reservation_suppressed uuid;
  v_reservation_success uuid;
  v_local_message uuid := gen_random_uuid();
begin
  insert into auth.users (id,email,raw_user_meta_data)
  values (
    v_user,
    'agent-outbound-policy-smoke@example.test',
    '{"full_name":"Agent Outbound Policy Smoke"}'::jsonb
  );

  select account_id into strict v_account
  from public.profiles
  where user_id=v_user;

  insert into public.contacts (id,user_id,account_id,phone,name)
  values
    (v_contact_active,v_user,v_account,'+967700000112','Active Session'),
    (v_contact_cold,v_user,v_account,'+967700000113','Cold Session'),
    (v_contact_stale,v_user,v_account,'+967700000114','Stale Template'),
    (v_contact_suppressed,v_user,v_account,'+967700000115','Suppressed After Reserve'),
    (v_contact_success,v_user,v_account,'+967700000116','Template Success');

  insert into public.conversations (id,user_id,account_id,contact_id)
  values
    (v_conv_active,v_user,v_account,v_contact_active),
    (v_conv_cold,v_user,v_account,v_contact_cold),
    (v_conv_stale,v_user,v_account,v_contact_stale),
    (v_conv_suppressed,v_user,v_account,v_contact_suppressed),
    (v_conv_success,v_user,v_account,v_contact_success);

  insert into public.messages (
    conversation_id,sender_type,content_type,content_text,status,created_at
  ) values
    (v_conv_active,'customer','text','recent inbound','sent',now()),
    (v_conv_suppressed,'customer','text','recent inbound','sent',now());

  insert into public.ai_provider_connections (
    id,account_id,name,preset_id,protocol,api_root,
    encrypted_api_key,connection_fingerprint,status
  ) values (
    v_connection,v_account,'Outbound Policy Provider','outbound-policy-smoke',
    'openai','https://example.test/v1','encrypted-smoke-key',
    'outbound-policy-smoke-112','verified'
  );

  insert into public.ai_agents (id,account_id,slug,name,purpose,status)
  values (
    v_agent,v_account,'outbound-policy-agent',
    'Outbound Policy Agent','custom','active'
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
    'manual','running','Outbound policy smoke','whatsapp',10,5,
    'outbound-policy-task-112','outbound-policy-correlation-112',v_user
  );

  insert into public.ai_agent_task_targets (
    id,account_id,task_id,contact_id,counterparty_role,status,
    conversation_id,attempt_count,idempotency_key
  ) values
    (
      v_target_active,v_account,v_task,v_contact_active,'supplier',
      'in_progress',v_conv_active,1,'outbound-policy-active-target-112'
    ),
    (
      v_target_cold,v_account,v_task,v_contact_cold,'supplier',
      'in_progress',v_conv_cold,1,'outbound-policy-cold-target-112'
    ),
    (
      v_target_stale,v_account,v_task,v_contact_stale,'supplier',
      'in_progress',v_conv_stale,1,'outbound-policy-stale-target-112'
    ),
    (
      v_target_suppressed,v_account,v_task,v_contact_suppressed,'supplier',
      'in_progress',v_conv_suppressed,1,'outbound-policy-suppressed-target-112'
    ),
    (
      v_target_success,v_account,v_task,v_contact_success,'supplier',
      'in_progress',v_conv_success,1,'outbound-policy-success-target-112'
    );

  insert into public.message_templates (
    user_id,account_id,name,category,language,body_text,status
  ) values (
    v_user,v_account,'coverage_supplier_request','UTILITY','en_US',
    'Please quote coverage for {{1}}.','APPROVED'
  );

  -- Active 24h session may reserve free-form text.
  v_run_active:=public.create_agent_execution(
    v_account,v_conv_active,null,v_agent,v_revision,v_connection,
    null,'phase7 smoke','customer','outbound',
    v_task,v_target_active,'task_target','attempt:1','supplier',
    'phase7-active-run-112'
  );
  if public.claim_agent_run(v_run_active,'phase7-worker',300)<>'claimed' then
    raise exception 'active run claim failed';
  end if;

  v_result:=public.reserve_agent_task_outbound_message(
    v_run_active,'coverage.sourcing_message',1,'text',
    'Please share your current coverage offer.',null,null,'[]'::jsonb,
    2,60,1440,true
  );

  if coalesce((v_result->>'reserved')::boolean,false)<>true
     or coalesce((v_result->>'session_window_active')::boolean,false)<>true then
    raise exception 'active-session text was not reserved: %',v_result;
  end if;

  v_reservation_active:=(v_result->>'reservation_id')::uuid;

  -- Same run/attempt is exactly-once at the reservation boundary.
  v_result:=public.reserve_agent_task_outbound_message(
    v_run_active,'coverage.sourcing_message',1,'text',
    'Different retry text must not create a second reservation.',
    null,null,'[]'::jsonb,2,60,1440,true
  );
  if v_result->>'reason'<>'existing'
     or (v_result->>'reservation_id')::uuid<>v_reservation_active then
    raise exception 'run reservation idempotency failed: %',v_result;
  end if;

  -- Once transport ownership is acquired, an ambiguous crash is never retried.
  v_result:=public.claim_agent_task_outbound_message(
    v_reservation_active,'transport-worker',120
  );
  if coalesce((v_result->>'claimed')::boolean,false)<>true then
    raise exception 'text reservation claim failed: %',v_result;
  end if;

  update public.ai_agent_task_outbound_messages
  set lease_expires_at=now()-interval '1 second'
  where id=v_reservation_active;

  v_sweep:=public.sweep_agent_task_outbound_messages(now());

  if coalesce((v_sweep->>'requires_reconciliation')::int,0)<1
     or not exists (
       select 1
       from public.ai_agent_task_outbound_messages
       where id=v_reservation_active
         and status='requires_reconciliation'
     ) then
    raise exception 'expired send lease did not require reconciliation: %',v_sweep;
  end if;

  v_result:=public.claim_agent_task_outbound_message(
    v_reservation_active,'transport-worker-2',120
  );
  if v_result->>'reason'<>'reconciliation_required' then
    raise exception 'reconciliation reservation was reclaimed: %',v_result;
  end if;

  -- Cold/business-initiated outreach cannot use free-form text.
  v_run_cold:=public.create_agent_execution(
    v_account,v_conv_cold,null,v_agent,v_revision,v_connection,
    null,'phase7 smoke','customer','outbound',
    v_task,v_target_cold,'task_target','attempt:1','supplier',
    'phase7-cold-run-112'
  );
  if public.claim_agent_run(v_run_cold,'phase7-worker',300)<>'claimed' then
    raise exception 'cold run claim failed';
  end if;

  v_result:=public.reserve_agent_task_outbound_message(
    v_run_cold,'coverage.sourcing_message',1,'text',
    'Cold free-form text must be rejected.',null,null,'[]'::jsonb,
    2,60,1440,true
  );
  if v_result->>'reason'<>'template_required' then
    raise exception 'cold text did not require a template: %',v_result;
  end if;

  -- Approval is rechecked at transport claim, not only at reservation.
  v_run_stale:=public.create_agent_execution(
    v_account,v_conv_stale,null,v_agent,v_revision,v_connection,
    null,'phase7 smoke','customer','outbound',
    v_task,v_target_stale,'task_target','attempt:1','supplier',
    'phase7-stale-template-run-112'
  );
  if public.claim_agent_run(v_run_stale,'phase7-worker',300)<>'claimed' then
    raise exception 'stale template run claim failed';
  end if;

  v_result:=public.reserve_agent_task_outbound_message(
    v_run_stale,'coverage.sourcing_message',1,'template',
    null,'coverage_supplier_request','en_US','["DXB"]'::jsonb,
    2,60,1440,true
  );
  if coalesce((v_result->>'reserved')::boolean,false)<>true then
    raise exception 'approved template was not reserved: %',v_result;
  end if;
  v_reservation_stale:=(v_result->>'reservation_id')::uuid;

  update public.message_templates
  set status='PAUSED'
  where account_id=v_account
    and name='coverage_supplier_request'
    and language='en_US';

  v_result:=public.claim_agent_task_outbound_message(
    v_reservation_stale,'transport-worker',120
  );
  if v_result->>'reason'<>'template_not_approved'
     or not exists (
       select 1 from public.ai_agent_task_outbound_messages
       where id=v_reservation_stale
         and status='failed'
         and error_code='TEMPLATE_NOT_APPROVED'
     ) then
    raise exception 'template approval was not rechecked: %',v_result;
  end if;

  update public.message_templates
  set status='APPROVED'
  where account_id=v_account
    and name='coverage_supplier_request'
    and language='en_US';

  -- Suppression is also rechecked immediately before transport ownership.
  v_run_suppressed:=public.create_agent_execution(
    v_account,v_conv_suppressed,null,v_agent,v_revision,v_connection,
    null,'phase7 smoke','customer','outbound',
    v_task,v_target_suppressed,'task_target','attempt:1','supplier',
    'phase7-suppressed-run-112'
  );
  if public.claim_agent_run(v_run_suppressed,'phase7-worker',300)<>'claimed' then
    raise exception 'suppressed run claim failed';
  end if;

  v_result:=public.reserve_agent_task_outbound_message(
    v_run_suppressed,'coverage.sourcing_message',1,'text',
    'This reservation will be suppressed before transport.',
    null,null,'[]'::jsonb,2,60,1440,true
  );
  if coalesce((v_result->>'reserved')::boolean,false)<>true then
    raise exception 'suppression-race setup reservation failed: %',v_result;
  end if;
  v_reservation_suppressed:=(v_result->>'reservation_id')::uuid;

  insert into public.ai_outreach_contact_controls (
    account_id,contact_id,channel,state,reason,source,created_by
  ) values (
    v_account,v_contact_suppressed,'whatsapp','opted_out',
    'smoke opt-out after reservation','test',v_user
  );

  v_result:=public.claim_agent_task_outbound_message(
    v_reservation_suppressed,'transport-worker',120
  );
  if v_result->>'reason'<>'suppressed'
     or not exists (
       select 1 from public.ai_agent_task_outbound_messages
       where id=v_reservation_suppressed
         and status='cancelled'
         and error_code='TARGET_SUPPRESSED'
     ) then
    raise exception 'suppression race was not closed: %',v_result;
  end if;

  -- Successful approved template flow updates reservation/run/target atomically.
  v_run_success:=public.create_agent_execution(
    v_account,v_conv_success,null,v_agent,v_revision,v_connection,
    null,'phase7 smoke','customer','outbound',
    v_task,v_target_success,'task_target','attempt:1','supplier',
    'phase7-template-success-run-112'
  );
  if public.claim_agent_run(v_run_success,'phase7-worker',300)<>'claimed' then
    raise exception 'template success run claim failed';
  end if;

  v_result:=public.reserve_agent_task_outbound_message(
    v_run_success,'coverage.sourcing_message',1,'template',
    null,'coverage_supplier_request','en_US','["Sanaa"]'::jsonb,
    2,60,1440,true
  );
  if coalesce((v_result->>'reserved')::boolean,false)<>true
     or coalesce((v_result->>'session_window_active')::boolean,false)<>false then
    raise exception 'cold approved template reservation failed: %',v_result;
  end if;
  v_reservation_success:=(v_result->>'reservation_id')::uuid;

  v_result:=public.claim_agent_task_outbound_message(
    v_reservation_success,'transport-worker',120
  );
  if coalesce((v_result->>'claimed')::boolean,false)<>true then
    raise exception 'approved template transport claim failed: %',v_result;
  end if;

  insert into public.messages (
    id,conversation_id,sender_type,content_type,content_text,
    template_name,message_id,status
  ) values (
    v_local_message,v_conv_success,'bot','template',
    'Please quote coverage for Sanaa.','coverage_supplier_request',
    'wamid.phase7.smoke','sent'
  );

  if not public.complete_agent_task_outbound_message(
    v_reservation_success,'transport-worker',v_local_message,
    'wamid.phase7.smoke',11,7
  ) then
    raise exception 'outbound completion RPC returned false';
  end if;

  if not exists (
    select 1
    from public.ai_agent_task_outbound_messages
    where id=v_reservation_success
      and status='sent'
      and local_message_id=v_local_message
      and whatsapp_message_id='wamid.phase7.smoke'
  ) then
    raise exception 'outbound reservation was not completed';
  end if;

  if not exists (
    select 1
    from public.ai_agent_runs
    where id=v_run_success
      and status='succeeded'
      and outbound_message_id=v_local_message
      and input_tokens=11
      and output_tokens=7
  ) then
    raise exception 'outbound run was not completed';
  end if;

  if not exists (
    select 1
    from public.ai_agent_task_targets
    where id=v_target_success
      and status='awaiting_reply'
      and first_contacted_at is not null
      and last_outbound_message_id=v_local_message
  ) then
    raise exception 'outbound target was not moved to awaiting_reply';
  end if;

  if has_function_privilege(
       'anon',
       'public.reserve_agent_task_outbound_message(uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.reserve_agent_task_outbound_message(uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.reserve_agent_task_outbound_message(uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean)',
       'EXECUTE'
     ) then
    raise exception 'outbound reservation RPC privileges are unsafe';
  end if;

  if not exists (
    select 1 from pg_class
    where oid='public.ai_agent_task_outbound_messages'::regclass
      and relrowsecurity
  ) then
    raise exception 'outbound reservation table RLS is disabled';
  end if;

  update public.ai_agent_runs
  set outbound_message_id=null
  where account_id=v_account;

  delete from public.ai_agent_task_outbound_messages where account_id=v_account;
  delete from public.ai_agent_run_events where account_id=v_account;
  delete from public.ai_agent_runs where account_id=v_account;
  delete from public.ai_agent_task_events where account_id=v_account;
  delete from public.ai_agent_task_targets where account_id=v_account;
  delete from public.ai_agent_tasks where account_id=v_account;
  delete from public.ai_outreach_contact_controls where account_id=v_account;
  delete from public.message_templates where account_id=v_account;
  delete from public.messages
  where conversation_id in (
    v_conv_active,v_conv_cold,v_conv_stale,v_conv_suppressed,v_conv_success
  );
  delete from public.conversations where account_id=v_account;
  delete from public.contacts where account_id=v_account;
  delete from public.ai_agent_revisions where account_id=v_account;
  delete from public.ai_agents where account_id=v_account;
  delete from public.ai_provider_connections where account_id=v_account;
  delete from public.profiles where user_id=v_user;
  delete from public.accounts where id=v_account;
  delete from auth.users where id=v_user;

  raise notice 'agent outbound messaging policy smoke passed';
end
$$;
