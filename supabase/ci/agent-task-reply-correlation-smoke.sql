do $$
declare
  v_user uuid := '00000000-0000-4000-8000-000000000113';
  v_account uuid;
  v_connection uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();

  v_contact_reply uuid := gen_random_uuid();
  v_contact_ambiguous uuid := gen_random_uuid();
  v_contact_human uuid := gen_random_uuid();

  v_conv_reply uuid := gen_random_uuid();
  v_conv_ambiguous uuid := gen_random_uuid();
  v_conv_human uuid := gen_random_uuid();

  v_task_reply uuid := gen_random_uuid();
  v_task_ambiguous_a uuid := gen_random_uuid();
  v_task_ambiguous_b uuid := gen_random_uuid();
  v_task_human uuid := gen_random_uuid();

  v_target_reply uuid := gen_random_uuid();
  v_target_ambiguous_a uuid := gen_random_uuid();
  v_target_ambiguous_b uuid := gen_random_uuid();
  v_target_human uuid := gen_random_uuid();

  v_out_reply uuid := gen_random_uuid();
  v_out_ambiguous_a uuid := gen_random_uuid();
  v_out_ambiguous_b uuid := gen_random_uuid();
  v_out_human uuid := gen_random_uuid();
  v_in_reply uuid := gen_random_uuid();
  v_task_reply_response uuid := gen_random_uuid();
  v_in_followup uuid := gen_random_uuid();
  v_in_ambiguous uuid := gen_random_uuid();
  v_human_local uuid := gen_random_uuid();

  v_human_run uuid;
  v_human_reservation uuid := gen_random_uuid();
  v_result jsonb;
  v_run_id uuid;
  v_replay_run_id uuid;
  v_claimed uuid;
begin
  insert into auth.users(id,email,raw_user_meta_data)
  values (
    v_user,
    'agent-reply-correlation-smoke@example.test',
    '{"full_name":"Agent Reply Correlation Smoke"}'::jsonb
  );

  select account_id into strict v_account
  from public.profiles
  where user_id=v_user;

  insert into public.contacts(id,user_id,account_id,phone,name)
  values
    (v_contact_reply,v_user,v_account,'+967700000113','Reply Contact'),
    (v_contact_ambiguous,v_user,v_account,'+967700000114','Ambiguous Contact'),
    (v_contact_human,v_user,v_account,'+967700000115','Human Contact');

  insert into public.conversations(id,user_id,account_id,contact_id)
  values
    (v_conv_reply,v_user,v_account,v_contact_reply),
    (v_conv_ambiguous,v_user,v_account,v_contact_ambiguous),
    (v_conv_human,v_user,v_account,v_contact_human);

  insert into public.ai_provider_connections(
    id,account_id,name,preset_id,protocol,api_root,
    encrypted_api_key,connection_fingerprint,status
  ) values (
    v_connection,v_account,'Reply Correlation Provider','reply-correlation-smoke',
    'openai','https://example.test/v1','encrypted-smoke-key',
    'reply-correlation-smoke-113','verified'
  );

  insert into public.ai_agents(id,account_id,slug,name,purpose,status)
  values (
    v_agent,v_account,'reply-correlation-agent',
    'Reply Correlation Agent','custom','active'
  );

  insert into public.ai_agent_revisions(
    id,account_id,agent_id,revision_number,status,
    provider_connection_id,model
  ) values (
    v_revision,v_account,v_agent,1,'published',
    v_connection,'smoke-model'
  );

  insert into public.ai_agent_tasks(
    id,account_id,task_type,task_type_version,agent_id,agent_revision_id,
    trigger_type,status,objective,channel,max_targets,max_attempts_per_target,
    idempotency_key,correlation_id,created_by
  ) values
    (
      v_task_reply,v_account,'coverage.sourcing',1,v_agent,v_revision,
      'manual','running','Reply correlation','whatsapp',3,3,
      'reply-correlation-task-113','reply-correlation-correlation-113',v_user
    ),
    (
      v_task_ambiguous_a,v_account,'coverage.sourcing',1,v_agent,v_revision,
      'manual','running','Ambiguous A','whatsapp',3,3,
      'reply-ambiguous-a-113','reply-ambiguous-a-correlation-113',v_user
    ),
    (
      v_task_ambiguous_b,v_account,'services.promotion',1,v_agent,v_revision,
      'manual','running','Ambiguous B','whatsapp',3,3,
      'reply-ambiguous-b-113','reply-ambiguous-b-correlation-113',v_user
    ),
    (
      v_task_human,v_account,'coverage.sourcing',1,v_agent,v_revision,
      'manual','running','Human takeover','whatsapp',3,3,
      'reply-human-task-113','reply-human-correlation-113',v_user
    );

  insert into public.messages(
    id,conversation_id,sender_type,content_type,content_text,message_id,status,created_at
  ) values
    (
      v_out_reply,v_conv_reply,'bot','text','Can you quote this?',
      'wamid.reply.out','sent',now()-interval '2 minutes'
    ),
    (
      v_out_ambiguous_a,v_conv_ambiguous,'bot','text','Task A',
      'wamid.ambiguous.a','sent',now()-interval '3 minutes'
    ),
    (
      v_out_ambiguous_b,v_conv_ambiguous,'bot','text','Task B',
      'wamid.ambiguous.b','sent',now()-interval '2 minutes'
    ),
    (
      v_out_human,v_conv_human,'bot','text','Human race setup',
      'wamid.human.out','sent',now()-interval '1 minute'
    );

  insert into public.ai_agent_task_targets(
    id,account_id,task_id,contact_id,counterparty_role,status,conversation_id,
    attempt_count,first_contacted_at,last_outbound_message_id,idempotency_key
  ) values
    (
      v_target_reply,v_account,v_task_reply,v_contact_reply,'supplier',
      'awaiting_reply',v_conv_reply,1,now()-interval '2 minutes',
      v_out_reply,'reply-target-113'
    ),
    (
      v_target_ambiguous_a,v_account,v_task_ambiguous_a,v_contact_ambiguous,'supplier',
      'awaiting_reply',v_conv_ambiguous,1,now()-interval '3 minutes',
      v_out_ambiguous_a,'ambiguous-target-a-113'
    ),
    (
      v_target_ambiguous_b,v_account,v_task_ambiguous_b,v_contact_ambiguous,'lead',
      'awaiting_reply',v_conv_ambiguous,1,now()-interval '2 minutes',
      v_out_ambiguous_b,'ambiguous-target-b-113'
    ),
    (
      v_target_human,v_account,v_task_human,v_contact_human,'supplier',
      'in_progress',v_conv_human,1,now()-interval '1 minute',
      v_out_human,'human-target-113'
    );

  insert into public.messages(
    id,conversation_id,sender_type,content_type,content_text,message_id,status,
    reply_to_message_id,created_at
  ) values (
    v_in_reply,v_conv_reply,'customer','text','Yes, I can quote.',
    'wamid.reply.in','delivered',v_out_reply,now()
  );

  v_result:=public.correlate_agent_task_inbound_reply(
    v_account,v_conv_reply,v_in_reply,v_out_reply,false
  );

  if v_result->>'status'<>'matched'
     or v_result->>'correlation_method'<>'reply_context' then
    raise exception 'reply context correlation failed: %',v_result;
  end if;

  v_run_id:=(v_result->>'run_id')::uuid;

  if not exists (
    select 1
    from public.ai_agent_runs
    where id=v_run_id
      and run_mode='inbound'
      and inbound_message_id=v_in_reply
      and task_id=v_task_reply
      and task_target_id=v_target_reply
      and trigger_type='task_reply'
      and ai_agent_id=v_agent
      and agent_revision_id=v_revision
      and provider_connection_id=v_connection
      and status='queued'
  ) then
    raise exception 'task reply run shape is invalid';
  end if;

  if not exists (
    select 1
    from public.ai_agent_task_targets
    where id=v_target_reply
      and status='replied'
      and replied_at is not null
      and next_action_at is null
  ) then
    raise exception 'reply target was not transitioned to replied';
  end if;

  v_result:=public.correlate_agent_task_inbound_reply(
    v_account,v_conv_reply,v_in_reply,v_out_reply,false
  );
  v_replay_run_id:=(v_result->>'run_id')::uuid;

  if v_result->>'reason'<>'existing'
     or v_replay_run_id<>v_run_id then
    raise exception 'reply correlation replay is not idempotent: %',v_result;
  end if;

  insert into public.messages(
    id,conversation_id,sender_type,content_type,content_text,message_id,status
  ) values (
    v_task_reply_response,v_conv_reply,'bot','text',
    'Task reply response','wamid.reply.agent-response','sent'
  );

  update public.ai_agent_runs
  set status='succeeded',
      completed_at=now(),
      outbound_message_id=v_task_reply_response
  where id=v_run_id;

  insert into public.messages(
    id,conversation_id,sender_type,content_type,content_text,message_id,status,
    reply_to_message_id,created_at
  ) values (
    v_in_followup,v_conv_reply,'customer','text','Follow-up reply',
    'wamid.reply.followup','delivered',v_task_reply_response,now()
  );

  v_result:=public.correlate_agent_task_inbound_reply(
    v_account,v_conv_reply,v_in_followup,v_task_reply_response,false
  );

  if v_result->>'status'<>'matched'
     or v_result->>'correlation_method'<>'reply_context'
     or (v_result->>'task_target_id')::uuid<>v_target_reply then
    raise exception 'multi-turn task reply correlation failed: %',v_result;
  end if;

  update public.ai_agent_tasks
  set claimed_by='reply-smoke-worker',
      lease_expires_at=now()+interval '2 minutes'
  where id=v_task_reply;

  v_claimed:=public.claim_next_agent_task_target(
    v_task_reply,'reply-smoke-worker',120
  );
  if v_claimed is not null then
    raise exception 'replied target re-entered outbound claim path';
  end if;

  insert into public.messages(
    id,conversation_id,sender_type,content_type,content_text,message_id,status,created_at
  ) values (
    v_in_ambiguous,v_conv_ambiguous,'customer','text',
    'Which one?','wamid.ambiguous.in','delivered',now()
  );

  v_result:=public.correlate_agent_task_inbound_reply(
    v_account,v_conv_ambiguous,v_in_ambiguous,null,false
  );

  if v_result->>'status'<>'ambiguous'
     or coalesce((v_result->>'candidate_count')::int,0)<>2 then
    raise exception 'ambiguous reply did not fail closed: %',v_result;
  end if;

  if exists (
    select 1
    from public.ai_agent_runs
    where inbound_message_id=v_in_ambiguous
  ) then
    raise exception 'ambiguous reply created an agent run';
  end if;

  v_human_run:=public.create_agent_execution(
    v_account,v_conv_human,null,v_agent,v_revision,v_connection,
    null,'phase8 human race','customer','outbound',
    v_task_human,v_target_human,'task_target','attempt:1','supplier',
    'phase8-human-run-113'
  );

  if public.claim_agent_run(v_human_run,'phase8-human-worker',300)<>'claimed' then
    raise exception 'human-race outbound run claim failed';
  end if;

  insert into public.ai_agent_task_outbound_messages(
    id,account_id,task_id,task_target_id,run_id,attempt_number,
    policy_key,policy_version,message_kind,candidate_text,template_params,
    session_window_active,status,idempotency_key,claimed_by,lease_expires_at
  ) values (
    v_human_reservation,v_account,v_task_human,v_target_human,v_human_run,1,
    'coverage.sourcing_message',1,'text','In-flight text','[]'::jsonb,
    true,'sending','phase8-human-reservation-113',
    'transport-worker',now()+interval '2 minutes'
  );

  update public.conversations
  set assigned_agent_id=v_user
  where id=v_conv_human;

  if not exists (
    select 1
    from public.ai_agent_task_targets
    where id=v_target_human
      and status='paused_for_human'
      and next_action_at is null
      and claimed_by is null
      and lease_expires_at is null
  ) then
    raise exception 'human assignment did not pause the task target';
  end if;

  if not exists (
    select 1
    from public.ai_agent_runs
    where id=v_human_run
      and status='claimed'
  ) then
    raise exception 'in-flight Meta send run was cancelled despite sending lease';
  end if;

  insert into public.messages(
    id,conversation_id,sender_type,content_type,content_text,message_id,status
  ) values (
    v_human_local,v_conv_human,'bot','text','In-flight text',
    'wamid.human.sent','sent'
  );

  if not public.complete_agent_task_outbound_message(
    v_human_reservation,'transport-worker',v_human_local,
    'wamid.human.sent',3,2
  ) then
    raise exception 'in-flight completion failed';
  end if;

  if not exists (
    select 1
    from public.ai_agent_task_targets
    where id=v_target_human
      and status='paused_for_human'
      and last_outbound_message_id=v_human_local
  ) then
    raise exception 'late send completion overwrote paused_for_human';
  end if;

  if has_function_privilege(
       'anon',
       'public.correlate_agent_task_inbound_reply(uuid,uuid,uuid,uuid,boolean)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.correlate_agent_task_inbound_reply(uuid,uuid,uuid,uuid,boolean)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.correlate_agent_task_inbound_reply(uuid,uuid,uuid,uuid,boolean)',
       'EXECUTE'
     ) then
    raise exception 'reply correlation RPC privileges are unsafe';
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
  delete from public.messages
  where conversation_id in (v_conv_reply,v_conv_ambiguous,v_conv_human);
  delete from public.conversations where account_id=v_account;
  delete from public.contacts where account_id=v_account;
  delete from public.ai_agent_revisions where account_id=v_account;
  delete from public.ai_agents where account_id=v_account;
  delete from public.ai_provider_connections where account_id=v_account;
  delete from public.profiles where user_id=v_user;
  delete from public.accounts where id=v_account;
  delete from auth.users where id=v_user;

  raise notice 'agent task reply correlation smoke passed';
end
$$;
