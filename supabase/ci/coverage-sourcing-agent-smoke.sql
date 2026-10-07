do $$
declare
  v_user uuid := '00000000-0000-4000-8000-000000000118';
  v_account uuid;
  v_service uuid;
  v_connection uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_requester uuid := gen_random_uuid();
  v_supplier uuid := gen_random_uuid();
  v_conversation uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_task uuid;
  v_target uuid := gen_random_uuid();
  v_outbound_message uuid := gen_random_uuid();
  v_inbound_message uuid := gen_random_uuid();
  v_change_request uuid;
  v_confirmation_code text;
  v_reply jsonb;
  v_offer uuid := gen_random_uuid();
  v_north uuid;
  v_south uuid;
begin
  insert into auth.users(id,email,raw_user_meta_data)
  values (
    v_user,
    'coverage-sourcing-outcome-smoke@example.test',
    '{"full_name":"Coverage Sourcing Outcome Smoke"}'::jsonb
  );

  select account_id into strict v_account
  from public.profiles
  where user_id=v_user;

  select id into strict v_service
  from public.services
  where account_id=v_account
    and code='coverage';

  select id into strict v_north
  from public.coverage_regions
  where account_id=v_account
    and code='sanaa';

  select id into strict v_south
  from public.coverage_regions
  where account_id=v_account
    and code='aden';

  insert into public.contacts(id,user_id,account_id,phone,name)
  values
    (v_requester,v_user,v_account,'+967700000118','Coverage Requester'),
    (v_supplier,v_user,v_account,'+967700000119','Coverage Supplier');

  insert into public.conversations(id,user_id,account_id,contact_id)
  values (
    v_conversation,v_user,v_account,v_supplier
  );

  insert into public.ai_provider_connections(
    id,account_id,name,preset_id,protocol,api_root,
    encrypted_api_key,connection_fingerprint,status
  ) values (
    v_connection,v_account,'Coverage Outcome Provider','coverage-outcome-smoke',
    'openai','https://example.test/v1','encrypted-smoke-key',
    'coverage-outcome-smoke-118','verified'
  );

  insert into public.ai_agents(
    id,account_id,slug,name,purpose,status
  ) values (
    v_agent,v_account,'coverage-outcome-agent',
    'Coverage Outcome Agent','custom','active'
  );

  insert into public.ai_agent_revisions(
    id,account_id,agent_id,revision_number,status,
    provider_connection_id,model,operational_mode,outreach_policy
  ) values (
    v_revision,v_account,v_agent,1,'published',
    v_connection,'smoke-model','outbound',
    '{"bindings":[]}'::jsonb
  );

  update public.ai_agents
  set published_revision_id=v_revision
  where id=v_agent;

  insert into public.coverage_requests(
    id,account_id,service_id,requester_contact_id,
    requested_amount,reserved_amount,fulfilled_amount,currency,attributes,status,
    created_by
  ) values (
    v_request,v_account,v_service,v_requester,
    50000,0,0,'SAR',
    jsonb_build_object(
      'coverage_scope','domestic',
      'pay_region_id',v_north,
      'pay_method','cash',
      'receive_region_id',v_south,
      'receive_method','networks'
    ),
    'active',
    v_user
  );

  v_task:=public.create_ai_agent_task(
    v_account,
    'coverage.sourcing',
    1,
    v_agent,
    v_revision,
    'manual',
    'coverage_request:'||v_request::text,
    'Source Coverage smoke request',
    jsonb_build_object(
      'coverageRequestId',v_request,
      'request',jsonb_build_object(
        'requestId',v_request,
        'serviceId',v_service,
        'requestedAmount','50000',
        'remainingAmount','50000',
        'currency','SAR'
      )
    ),
    '{"requiredTagIds":[],"excludedTagIds":[],"maxNewContactsPerHour":10,"maxContactsPerAgentPerDay":20,"cooldownMinutes":60}'::jsonb,
    'whatsapp',
    5,
    2,
    '{"approvalMode":"task","maxFollowups":1}'::jsonb,
    null,
    'coverage-outcome-task-idempotency-118',
    'coverage-outcome-correlation-118',
    v_user
  );

  update public.ai_agent_tasks
  set status='running',
      started_at=now()
  where id=v_task;

  insert into public.messages(
    id,conversation_id,sender_type,content_type,content_text,message_id,status
  ) values (
    v_outbound_message,v_conversation,'bot','text',
    'Coverage sourcing smoke outreach',
    'wamid.coverage.outcome.out','sent'
  );

  insert into public.ai_agent_task_targets(
    id,account_id,task_id,contact_id,counterparty_role,status,conversation_id,
    attempt_count,first_contacted_at,last_outbound_message_id,idempotency_key,
    resolver_key,resolver_version
  ) values (
    v_target,v_account,v_task,v_supplier,'coverage_supplier',
    'awaiting_reply',v_conversation,1,now(),v_outbound_message,
    'coverage-outcome-target-118','coverage.supplier_candidates',1
  );

  insert into public.messages(
    id,conversation_id,sender_type,content_type,content_text,message_id,status,
    reply_to_message_id
  ) values (
    v_inbound_message,v_conversation,'customer','text',
    'أستطيع توفير خمسين ألف ريال سعودي.',
    'wamid.coverage.outcome.in','delivered',v_outbound_message
  );

  v_reply:=public.correlate_agent_task_inbound_reply(
    v_account,
    v_conversation,
    v_inbound_message,
    v_outbound_message,
    false
  );

  if v_reply->>'status'<>'matched'
     or (v_reply->>'task_id')::uuid<>v_task
     or (v_reply->>'task_target_id')::uuid<>v_target then
    raise exception 'Coverage sourcing reply correlation failed: %',v_reply;
  end if;

  select created.id, created.confirmation_code
    into strict v_change_request, v_confirmation_code
  from public.create_change_request_v3(
    v_account,
    'coverage.offer.create',
    1,
    'coverage_offer',
    null,
    'create',
    jsonb_build_object(
      'contact_id',v_supplier,
      'service_id',v_service,
      'total_amount','50000',
      'currency','SAR',
      'source_message_id',v_inbound_message
    ),
    null,
    'coverage-outcome-change-request-118',
    'Approve supplier Coverage offer',
    v_user
  ) as created;

  -- Dashboard approval authorizes through auth.uid(), so make the smoke
  -- execute under the same authenticated member identity instead of relying
  -- on postgres/service-role privilege to bypass the membership contract.
  perform set_config('request.jwt.claim.sub', v_user::text, true);

  if public.approve_change_request_dashboard_v2(
       v_account,
       v_change_request,
       v_confirmation_code,
       v_user
     )<>'approved' then
    raise exception 'Coverage sourcing change request approval failed';
  end if;

  insert into public.coverage_offers(
    id,account_id,service_id,provider_contact_id,reference_code,
    total_amount,reserved_amount,fulfilled_amount,currency,attributes,status,
    source_change_request_id,created_by
  ) values (
    v_offer,v_account,v_service,v_supplier,'SRC-OUTCOME-118',
    50000,0,0,'SAR',
    jsonb_build_object(
      'coverage_scope','domestic',
      'pay_region_id',v_south,
      'pay_method','networks',
      'receive_region_id',v_north,
      'receive_method','cash'
    ),
    'active',
    v_change_request,
    v_user
  );

  if not exists (
    select 1
    from public.ai_agent_task_targets
    where id=v_target
      and task_id=v_task
      and status='completed'
      and completed_at is not null
  ) then
    raise exception 'approved supplier offer did not complete the Task Target';
  end if;

  if not exists (
    select 1
    from public.ai_agent_tasks
    where id=v_task
      and status='completed'
      and completed_at is not null
  ) then
    raise exception 'sufficient compatible supply did not complete the Task';
  end if;

  if not exists (
    select 1
    from public.ai_agent_task_events
    where account_id=v_account
      and task_id=v_task
      and task_target_id=v_target
      and event_type='target.completed'
      and payload->>'outcome'='valid_offer_recorded'
  ) then
    raise exception 'valid supplier offer target outcome event is missing';
  end if;

  if not exists (
    select 1
    from public.ai_agent_task_events
    where account_id=v_account
      and task_id=v_task
      and event_type='task.completed'
      and payload->>'outcome'='required_amount_satisfied'
  ) then
    raise exception 'Coverage sourcing task completion event is missing';
  end if;

  update public.ai_agent_runs
  set outbound_message_id=null
  where account_id=v_account;

  delete from public.ai_agent_task_outbound_messages where account_id=v_account;
  delete from public.ai_agent_task_events where account_id=v_account;
  delete from public.ai_agent_run_events where account_id=v_account;
  delete from public.ai_agent_runs where account_id=v_account;
  delete from public.ai_agent_task_targets where account_id=v_account;
  delete from public.ai_agent_tasks where account_id=v_account;
  delete from public.business_event_outbox where account_id=v_account;
  delete from public.customer_intent_notifications where account_id=v_account;
  delete from public.coverage_matches where account_id=v_account;
  delete from public.coverage_offers where account_id=v_account;
  delete from public.coverage_requests where account_id=v_account;
  delete from public.change_requests where account_id=v_account;
  delete from public.messages where conversation_id=v_conversation;
  delete from public.conversations where account_id=v_account;
  delete from public.contacts where account_id=v_account;
  delete from public.ai_agent_revisions where account_id=v_account;
  delete from public.ai_agents where account_id=v_account;
  delete from public.ai_provider_connections where account_id=v_account;
  delete from public.profiles where user_id=v_user;
  delete from public.accounts where id=v_account;
  delete from auth.users where id=v_user;

  raise notice 'Coverage sourcing business outcome smoke passed';
end
$$;
