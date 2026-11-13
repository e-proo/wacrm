-- SOF-59: account-scoped, immutable Agent Task WhatsApp transport binding.
-- Runs against ephemeral local Supabase in CI, rolls all fixtures back.
BEGIN;
DO $$
DECLARE
  v_user uuid := '00000000-0000-4000-8000-000000001859';
  v_account uuid;
  v_other_user uuid := '00000000-0000-4000-8000-000000001860';
  v_other_account uuid;
  v_other_connection uuid := gen_random_uuid();
  v_ai_connection uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_meta uuid := gen_random_uuid();
  v_wa uuid := gen_random_uuid();
  v_wa_other uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid();
  v_task_meta uuid := gen_random_uuid();
  v_pending_task uuid := gen_random_uuid();
  v_second_task uuid := gen_random_uuid();
  v_second_target uuid := gen_random_uuid();
  v_second_contact uuid := gen_random_uuid();
  v_second_conv uuid := gen_random_uuid();
  v_second_run uuid;
  v_second_reservation uuid;
  v_contact uuid := gen_random_uuid();
  v_contact_meta uuid := gen_random_uuid();
  v_conv uuid := gen_random_uuid();
  v_conv_meta uuid := gen_random_uuid();
  v_target uuid := gen_random_uuid();
  v_target_meta uuid := gen_random_uuid();
  v_run uuid;
  v_run_meta uuid;
  v_reservation uuid;
  v_reservation_meta uuid;
  v_result jsonb;
  v_rejected boolean := false;
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data)
  VALUES (v_user,'agent-transport-binding-smoke@example.test',
    '{"full_name":"Agent Transport Binding Smoke"}'::jsonb);
  SELECT account_id INTO STRICT v_account FROM public.profiles
    WHERE user_id=v_user;
  INSERT INTO auth.users(id,email,raw_user_meta_data)
  VALUES (v_other_user,'agent-transport-foreign-tenant@example.test',
    '{"full_name":"Foreign Tenant Fixture"}'::jsonb);
  SELECT account_id INTO STRICT v_other_account FROM public.profiles
    WHERE user_id=v_other_user;
  INSERT INTO public.whatsapp_connections(
    id,account_id,provider,status,session_id
  ) VALUES (
    v_other_connection,v_other_account,'openwa','ready','sof59-foreign-session'
  );

  INSERT INTO public.whatsapp_connections(
    id,account_id,provider,status,session_id
  ) VALUES
    (v_meta,v_account,'meta_cloud','connected',null),
    (v_wa,v_account,'openwa','ready','sof59-session-A'),
    (v_wa_other,v_account,'openwa','ready','sof59-session-B');

  INSERT INTO public.contacts(id,user_id,account_id,phone,name)
  VALUES (v_contact,v_user,v_account,'+967700001859','SOF59 WA target'),
         (v_contact_meta,v_user,v_account,'+967700001860','SOF59 Meta target');
  INSERT INTO public.conversations(id,user_id,account_id,contact_id)
  VALUES (v_conv,v_user,v_account,v_contact),
         (v_conv_meta,v_user,v_account,v_contact_meta);
  INSERT INTO public.messages(
    conversation_id,sender_type,content_type,content_text,
    status,provider,connection_id,created_at
  ) VALUES
    (v_conv,'customer','text','consenting TEST inbound',
     'sent','openwa',v_wa,now());

  INSERT INTO public.ai_provider_connections(
    id,account_id,name,preset_id,protocol,api_root,
    encrypted_api_key,connection_fingerprint,status
  ) VALUES (
    v_ai_connection,v_account,'SOF59 Provider','sof59-provider',
    'openai','https://example.test/v1','encrypted-smoke-key',
    'sof59-provider-fingerprint','verified'
  );
  INSERT INTO public.ai_agents(id,account_id,slug,name,purpose,status)
  VALUES (v_agent,v_account,'sof59-agent','SOF59 Agent','custom','active');
  INSERT INTO public.ai_agent_revisions(
    id,account_id,agent_id,revision_number,status,
    provider_connection_id,model
  ) VALUES (
    v_revision,v_account,v_agent,1,'published',
    v_ai_connection,'smoke-model'
  );

  INSERT INTO public.ai_runtime_policies(
    account_id,multi_agent_enabled,recovery_worker_enabled,
    outbound_task_delivery_enabled,kill_switch,max_runs_per_minute,updated_by
  ) VALUES (
    v_account,true,true,true,false,100,v_user
  ) ON CONFLICT (account_id) DO UPDATE SET
    multi_agent_enabled=true,recovery_worker_enabled=true,
    outbound_task_delivery_enabled=true,kill_switch=false,
    max_runs_per_minute=100,updated_by=v_user;

  INSERT INTO public.ai_agent_tasks(
    id,account_id,task_type,task_type_version,agent_id,agent_revision_id,
    trigger_type,status,objective,target_policy,channel,max_targets,
    max_attempts_per_target,idempotency_key,correlation_id,created_by
  ) VALUES (
    v_task,v_account,'coverage.sourcing',1,v_agent,v_revision,
    'manual','running','SOF59 OpenWA',
    jsonb_build_object('whatsappConnectionId',v_wa::text),
    'whatsapp',1,2,'sof59-openwa-task-identity','sof59-openwa-task',v_user
  ), (
    v_task_meta,v_account,'coverage.sourcing',1,v_agent,v_revision,
    'manual','running','SOF59 Meta',
    jsonb_build_object('whatsappConnectionId',v_meta::text),
    'whatsapp',1,2,'sof59-meta-task-identity','sof59-meta-task',v_user
  );

  -- SOF-64: Task-level editing is possible only while pending, without
  -- Targets/Runs/outbound sends, and without raising Builder caps.
  INSERT INTO public.ai_agent_tasks(
    id,account_id,task_type,task_type_version,agent_id,agent_revision_id,
    trigger_type,status,objective,target_policy,channel,max_targets,
    max_attempts_per_target,idempotency_key,correlation_id,created_by
  ) VALUES (
    v_pending_task,v_account,'coverage.sourcing',2,v_agent,v_revision,
    'manual','queued','SOF64 pending task',
    '{}'::jsonb,'whatsapp',1,1,
    'sof64-pending-task-identity','sof64-pending-task',v_user
  );
  v_result:=public.update_pending_agent_task_connection(
    v_account,v_pending_task,v_other_user,v_wa,1,1
  );
  IF v_result->>'reason'<>'admin_required' THEN
    RAISE EXCEPTION 'SOF64 foreign tenant could edit Task: %',v_result;
  END IF;
  v_result:=public.update_pending_agent_task_connection(
    v_account,v_pending_task,v_user,v_other_connection,1,1
  );
  IF v_result->>'reason'<>'connection_not_found' THEN
    RAISE EXCEPTION 'SOF64 foreign session was accepted: %',v_result;
  END IF;
  v_result:=public.update_pending_agent_task_connection(
    v_account,v_pending_task,v_user,v_wa,1,1
  );
  IF v_result->>'updated'<>'true' OR
     NOT EXISTS (
       SELECT 1 FROM public.ai_agent_tasks WHERE id=v_pending_task
         AND target_policy->>'whatsappConnectionId'=v_wa::text
     ) THEN
    RAISE EXCEPTION 'SOF64 pending connection edit failed: %',v_result;
  END IF;
  v_result:=public.update_pending_agent_task_connection(
    v_account,v_pending_task,v_user,v_wa,2,1
  );
  IF v_result->>'reason'<>'caps_cannot_increase' THEN
    RAISE EXCEPTION 'SOF64 increased Task caps after creation: %',v_result;
  END IF;
  UPDATE public.ai_agent_tasks SET status='running' WHERE id=v_pending_task;
  v_result:=public.update_pending_agent_task_connection(
    v_account,v_pending_task,v_user,v_wa_other,1,1
  );
  IF v_result->>'reason'<>'task_not_editable' THEN
    RAISE EXCEPTION 'SOF64 edited a started Task: %',v_result;
  END IF;

  INSERT INTO public.ai_agent_task_targets(
    id,account_id,task_id,contact_id,counterparty_role,status,
    conversation_id,attempt_count,idempotency_key
  ) VALUES (
    v_target,v_account,v_task,v_contact,'supplier','in_progress',
    v_conv,1,'sof59-openwa-target'
  ), (
    v_target_meta,v_account,v_task_meta,v_contact_meta,'supplier','in_progress',
    v_conv_meta,1,'sof59-meta-target'
  );

  v_run:=public.create_agent_execution(
    v_account,v_conv,null,v_agent,v_revision,v_ai_connection,
    null,'SOF59','customer','outbound',v_task,v_target,
    'task_target','attempt:1','supplier','sof59-openwa-run'
  );
  IF public.claim_agent_run(v_run,'sof59-worker',300)<>'claimed' THEN
    RAISE EXCEPTION 'SOF59 outbound run could not be claimed';
  END IF;

  -- An inbound on connection A must NOT authorize sending on connection B.
  UPDATE public.ai_agent_tasks
    SET target_policy=jsonb_build_object('whatsappConnectionId',v_wa_other::text)
    WHERE id=v_task;
  v_result:=public.reserve_bound_agent_task_outbound_message(
    v_run,'coverage.sourcing_message',1,'text',
    'Safe bounded test text',null,null,'[]'::jsonb,0,60,1440,true
  );
  IF v_result->>'reason'<>'connection_session_window_closed' THEN
    RAISE EXCEPTION 'SOF59 accepted text on a different session: %',v_result;
  END IF;

  -- Two independent OpenWA sessions are usable under the same Agent/account.
  -- The reservation of session B must never rewrite session A's binding.
  INSERT INTO public.contacts(id,user_id,account_id,phone,name)
    VALUES (v_second_contact,v_user,v_account,'+967700001861','SOF62 second OpenWA');
  INSERT INTO public.conversations(id,user_id,account_id,contact_id)
    VALUES (v_second_conv,v_user,v_account,v_second_contact);
  INSERT INTO public.messages(
    conversation_id,sender_type,content_type,content_text,
    status,provider,connection_id,created_at
  ) VALUES (
    v_second_conv,'customer','text','second session opt-in',
    'sent','openwa',v_wa_other,now()
  );
  INSERT INTO public.ai_agent_tasks(
    id,account_id,task_type,task_type_version,agent_id,agent_revision_id,
    trigger_type,status,objective,target_policy,channel,max_targets,
    max_attempts_per_target,idempotency_key,correlation_id,created_by
  ) VALUES (
    v_second_task,v_account,'coverage.sourcing',2,v_agent,v_revision,
    'manual','running','SOF62 second OpenWA independent Task',
    jsonb_build_object('whatsappConnectionId',v_wa_other::text),
    'whatsapp',1,1,'sof62-second-openwa-task','sof62-second-openwa',v_user
  );
  INSERT INTO public.ai_agent_task_targets(
    id,account_id,task_id,contact_id,counterparty_role,status,
    conversation_id,attempt_count,idempotency_key
  ) VALUES (
    v_second_target,v_account,v_second_task,v_second_contact,
    'supplier','in_progress',v_second_conv,1,'sof62-second-openwa-target'
  );
  v_second_run:=public.create_agent_execution(
    v_account,v_second_conv,null,v_agent,v_revision,v_ai_connection,
    null,'SOF62','customer','outbound',v_second_task,v_second_target,
    'task_target','attempt:1','supplier','sof62-second-openwa-run'
  );
  IF public.claim_agent_run(v_second_run,'sof62-worker',300)<>'claimed' THEN
    RAISE EXCEPTION 'SOF62 second session Agent Run claim failed';
  END IF;
  v_result:=public.reserve_expected_provider_agent_task_outbound_message(
    v_second_run,'coverage.sourcing_message',2,'text',
    'Second safe TEST text',null,null,'[]'::jsonb,0,60,1440,true,
    'openwa'
  );
  IF v_result->>'reserved'<>'true'
     OR (v_result->>'connection_id')::uuid<>v_wa_other
     OR v_result->>'provider'<>'openwa' THEN
    RAISE EXCEPTION 'SOF62 session B was not independently bound: %',v_result;
  END IF;
  v_second_reservation:=(v_result->>'reservation_id')::uuid;
  UPDATE public.whatsapp_connections SET status='disconnected'
    WHERE id=v_wa_other;
  v_result:=public.claim_bound_agent_task_outbound_message(
    v_second_reservation,'sof62-transport',120
  );
  IF v_result->>'reason'<>'connection_not_ready' THEN
    RAISE EXCEPTION 'SOF62 dispatched disconnected session B: %',v_result;
  END IF;
  UPDATE public.whatsapp_connections SET status='ready'
    WHERE id=v_wa_other;
  v_result:=public.claim_bound_agent_task_outbound_message(
    v_second_reservation,'sof62-transport',120
  );
  IF v_result->>'claimed'<>'true' THEN
    RAISE EXCEPTION 'SOF62 session B did not recover safely: %',v_result;
  END IF;

  -- A session in another tenant is not a valid route, even when ready.
  UPDATE public.ai_agent_tasks
    SET target_policy=jsonb_build_object(
      'whatsappConnectionId',v_other_connection::text
    ) WHERE id=v_task;
  v_result:=public.reserve_bound_agent_task_outbound_message(
    v_run,'coverage.sourcing_message',1,'text',
    'Safe bounded test text',null,null,'[]'::jsonb,0,60,1440,true
  );
  IF v_result->>'reason'<>'connection_not_found' THEN
    RAISE EXCEPTION 'SOF59 accepted foreign tenant connection: %',v_result;
  END IF;

  -- Archived sessions are never reused, even if their status still says ready.
  UPDATE public.whatsapp_connections SET archived_at=now()
    WHERE id=v_wa_other;
  UPDATE public.ai_agent_tasks
    SET target_policy=jsonb_build_object(
      'whatsappConnectionId',v_wa_other::text
    ) WHERE id=v_task;
  v_result:=public.reserve_bound_agent_task_outbound_message(
    v_run,'coverage.sourcing_message',1,'text',
    'Safe bounded test text',null,null,'[]'::jsonb,0,60,1440,true
  );
  IF v_result->>'reason'<>'connection_archived' THEN
    RAISE EXCEPTION 'SOF59 accepted archived ready session: %',v_result;
  END IF;

  -- Missing explicit session must never silently fall back to Meta.
  UPDATE public.ai_agent_tasks
    SET target_policy='{}'::jsonb WHERE id=v_task;
  UPDATE public.messages SET connection_id=null,provider=null
    WHERE conversation_id=v_conv AND sender_type='customer';
  v_result:=public.reserve_bound_agent_task_outbound_message(
    v_run,'coverage.sourcing_message',1,'text',
    'Safe bounded test text',null,null,'[]'::jsonb,0,60,1440,true
  );
  IF v_result->>'reason'<>'connection_selection_required' THEN
    RAISE EXCEPTION 'SOF59 silently fell back to Meta: %',v_result;
  END IF;

  -- Restore valid OpenWA and exercise the bound path.
  UPDATE public.messages SET connection_id=v_wa,provider='openwa'
    WHERE conversation_id=v_conv AND sender_type='customer';
  UPDATE public.ai_agent_tasks
    SET target_policy=jsonb_build_object('whatsappConnectionId',v_wa::text)
    WHERE id=v_task;

  v_result:=public.reserve_bound_agent_task_outbound_message(
    v_run,'coverage.sourcing_message',1,'text',
    'Safe bounded test text',null,null,'[]'::jsonb,0,60,1440,true
  );
  IF v_result->>'reserved'<>'true' OR v_result->>'provider'<>'openwa'
     OR (v_result->>'connection_id')::uuid<>v_wa THEN
    RAISE EXCEPTION 'SOF59 OpenWA reservation did not bind: %',v_result;
  END IF;
  v_reservation:=(v_result->>'reservation_id')::uuid;

  -- An expected-provider disagreement MUST roll back the new policy call.
  v_rejected := false;
  BEGIN
    PERFORM public.reserve_expected_provider_agent_task_outbound_message(
      v_run,'coverage.sourcing_message',2,'text',
      'Wrong provider test',null,null,'[]'::jsonb,0,60,1440,true,
      'meta_cloud'
    );
  EXCEPTION WHEN OTHERS THEN
    IF position('AGENT_TASK_PROVIDER_CHANGED' in SQLERRM)>0 THEN
      v_rejected:=true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'SOF60 permitted provider switch between policy and reserve';
  END IF;

  v_result:=public.reserve_expected_provider_agent_task_outbound_message(
    v_run,'coverage.sourcing_message',2,'text',
    'Same provider authorized',null,null,'[]'::jsonb,0,60,1440,true,
    'openwa'
  );
  IF v_result->>'reserved'<>'true'
     OR v_result->>'provider'<>'openwa'
     OR (v_result->>'reservation_id')::uuid<>v_reservation THEN
    RAISE EXCEPTION 'SOF60 matched provider lost idempotency: %',v_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.ai_agent_task_outbound_messages
    WHERE id=v_reservation AND account_id=v_account
      AND provider='openwa' AND connection_id=v_wa
  ) THEN
    RAISE EXCEPTION 'SOF59 OpenWA binding was not stored';
  END IF;

  -- Immutable transport, even if a task policy changes after reservation.
  BEGIN
    UPDATE public.ai_agent_task_outbound_messages
      SET connection_id=v_wa_other WHERE id=v_reservation;
  EXCEPTION WHEN OTHERS THEN
    IF position('AGENT_TASK_TRANSPORT_BINDING_IMMUTABLE' in SQLERRM)>0 THEN
      v_rejected:=true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'SOF59 permitted reservation transport reassignment';
  END IF;

  -- Ready state is checked again BEFORE transport ownership.
  UPDATE public.whatsapp_connections SET status='disconnected'
    WHERE id=v_wa;
  v_result:=public.claim_bound_agent_task_outbound_message(
    v_reservation,'sof59-sender',120
  );
  IF v_result->>'reason'<>'connection_not_ready' THEN
    RAISE EXCEPTION 'SOF59 allowed disconnected OpenWA: %',v_result;
  END IF;
  UPDATE public.whatsapp_connections SET status='ready'
    WHERE id=v_wa;
  v_result:=public.claim_bound_agent_task_outbound_message(
    v_reservation,'sof59-sender',120
  );
  IF v_result->>'claimed'<>'true' THEN
    RAISE EXCEPTION 'SOF59 ready OpenWA was not claimed: %',v_result;
  END IF;
  v_result:=public.claim_bound_agent_task_outbound_message(
    v_reservation,'sof59-other-worker',120
  );
  IF v_result->>'reason'<>'reconciliation_required' THEN
    RAISE EXCEPTION 'SOF59 duplicate transport ownership: %',v_result;
  END IF;

  -- Meta initial outreach remains an approved template with frozen Meta ID.
  INSERT INTO public.message_templates(
    user_id,account_id,name,category,language,body_text,status
  ) VALUES (
    v_user,v_account,'sof59_meta_template','Utility','ar',
    'Test template {{1}}','APPROVED'
  );
  v_run_meta:=public.create_agent_execution(
    v_account,v_conv_meta,null,v_agent,v_revision,v_ai_connection,
    null,'SOF59 Meta','customer','outbound',v_task_meta,v_target_meta,
    'task_target','attempt:1','supplier','sof59-meta-run'
  );
  IF public.claim_agent_run(v_run_meta,'sof59-worker',300)<>'claimed' THEN
    RAISE EXCEPTION 'SOF59 Meta run claim failed';
  END IF;

  v_result:=public.reserve_bound_agent_task_outbound_message(
    v_run_meta,'coverage.sourcing_message',1,'template',
    null,'sof59_meta_template','ar','["TEST"]'::jsonb,
    0,60,1440,true
  );
  IF v_result->>'reserved'<>'true' OR v_result->>'provider'<>'meta_cloud'
     OR (v_result->>'connection_id')::uuid<>v_meta THEN
    RAISE EXCEPTION 'SOF59 Meta template binding failed: %',v_result;
  END IF;
  v_reservation_meta:=(v_result->>'reservation_id')::uuid;

  -- Simulate Meta going offline before claim: fail closed.
  UPDATE public.whatsapp_connections SET status='disconnected'
    WHERE id=v_meta;
  v_result:=public.claim_bound_agent_task_outbound_message(
    v_reservation_meta,'sof59-meta-sender',120
  );
  IF v_result->>'reason'<>'connection_not_ready' THEN
    RAISE EXCEPTION 'SOF59 claimed offline Meta: %',v_result;
  END IF;
  UPDATE public.whatsapp_connections SET status='connected'
    WHERE id=v_meta;
  v_result:=public.claim_bound_agent_task_outbound_message(
    v_reservation_meta,'sof59-meta-sender',120
  );
  IF v_result->>'claimed'<>'true' THEN
    RAISE EXCEPTION 'SOF59 Meta approved template was blocked: %',v_result;
  END IF;

  -- Archive-aware claim: an OpenWA session remains rejected even if it
  -- had previously been marked ready. This cannot be "auto-unarchived".
  UPDATE public.whatsapp_connections
    SET archived_at=now() WHERE id=v_wa;
  v_result:=public.claim_bound_agent_task_outbound_message(
    v_reservation,'sof59-other-worker',120
  );
  -- Already claimed: original RPC must preserve ambiguity rather than retry.
  IF v_result->>'reason'<>'reconciliation_required' THEN
    RAISE EXCEPTION 'SOF59 archived previously-claimed message was retried';
  END IF;

  IF has_function_privilege(
      'anon',
      'public.reserve_bound_agent_task_outbound_message(uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean)',
      'EXECUTE'
    ) OR has_function_privilege(
      'authenticated',
      'public.claim_bound_agent_task_outbound_message(uuid,text,integer)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'SOF59 RPC grants are too broad';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.reserve_expected_provider_agent_task_outbound_message(uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.reserve_expected_provider_agent_task_outbound_message(uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean,text)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.reserve_expected_provider_agent_task_outbound_message(uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'SOF60 provider-locked RPC grants are unsafe';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.update_pending_agent_task_connection(uuid,uuid,uuid,uuid,integer,integer)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.update_pending_agent_task_connection(uuid,uuid,uuid,uuid,integer,integer)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.update_pending_agent_task_connection(uuid,uuid,uuid,uuid,integer,integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'SOF64 edit RPC grants are too broad';
  END IF;

  RAISE NOTICE 'SOF59 bound transport smoke passed';
END $$;
ROLLBACK;
