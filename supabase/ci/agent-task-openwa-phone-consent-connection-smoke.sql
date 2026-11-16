-- SOF-66: reproduce the live failure (AI model provider != OpenWA session)
-- without sending WhatsApp messages. Ephemeral CI fixture, full ROLLBACK.
-- Cover expired/stale session window, exact phone-call opt-in, wrong session,
-- wrong workload, pause/revocation, explicit provider binding, Meta safety.
BEGIN;
DO $smoke$
DECLARE
  v_user uuid := '00000000-0000-4000-8000-000000001170';
  v_account uuid;
  v_ai uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_wa uuid := gen_random_uuid();
  v_wa_other uuid := gen_random_uuid();
  v_meta uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid();
  v_meta_task uuid := gen_random_uuid();
  v_contact uuid := gen_random_uuid();
  v_cold_contact uuid := gen_random_uuid();
  v_meta_contact uuid := gen_random_uuid();
  v_conv uuid := gen_random_uuid();
  v_cold_conv uuid := gen_random_uuid();
  v_meta_conv uuid := gen_random_uuid();
  v_target uuid := gen_random_uuid();
  v_cold_target uuid := gen_random_uuid();
  v_meta_target uuid := gen_random_uuid();
  v_run uuid;
  v_cold_run uuid;
  v_meta_run uuid;
  v_result jsonb;
  v_reservation uuid;
  v_hash text;
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data)
  VALUES (v_user,'sof66-consent-connection-regression@example.test',
    '{"full_name":"SOF66 Consent Regression"}'::jsonb);
  SELECT account_id INTO STRICT v_account
  FROM public.profiles WHERE user_id=v_user;

  INSERT INTO public.whatsapp_connections(
    id,account_id,provider,status,session_id
  ) VALUES
    (v_wa,v_account,'openwa','ready','sof66-consent-session-A'),
    (v_wa_other,v_account,'openwa','ready','sof66-consent-session-B'),
    (v_meta,v_account,'meta_cloud','connected',NULL);

  INSERT INTO public.whatsapp_connection_guardrails(
    account_id,connection_id,pilot_enabled,manual_paused,
    hourly_cap,daily_cap,first_touch_daily_cap,
    warmup_hourly_cap,warmup_daily_cap,minimum_interval_ms,
    pilot_agent_hourly_cap,pilot_agent_daily_cap
  ) VALUES (
    v_account,v_wa,true,false,20,100,3,20,100,15000,20,100
  ) ON CONFLICT(connection_id) DO UPDATE SET
    pilot_enabled=true,manual_paused=false,
    hourly_cap=20,daily_cap=100,first_touch_daily_cap=3,
    pilot_agent_hourly_cap=20,pilot_agent_daily_cap=100;

  INSERT INTO public.contacts(id,user_id,account_id,phone,name)
  VALUES
    (v_contact,v_user,v_account,'+967700001170','Consented old inbound'),
    (v_cold_contact,v_user,v_account,'+967700001171','Unapproved old inbound'),
    (v_meta_contact,v_user,v_account,'+967700001172','Meta template target');
  INSERT INTO public.conversations(id,user_id,account_id,contact_id)
  VALUES
    (v_conv,v_user,v_account,v_contact),
    (v_cold_conv,v_user,v_account,v_cold_contact),
    (v_meta_conv,v_user,v_account,v_meta_contact);

  -- Both users have stale inbound beyond 24h on the chosen OpenWA session.
  INSERT INTO public.messages(
    conversation_id,sender_type,content_type,content_text,status,
    provider,connection_id,provider_chat_id,created_at
  ) VALUES
    (v_conv,'customer','text','old verified chat','sent',
     'openwa',v_wa,'967700001170@c.us',now()-interval '4 days'),
    (v_cold_conv,'customer','text','old verified chat','sent',
     'openwa',v_wa,'967700001171@c.us',now()-interval '4 days');

  INSERT INTO public.ai_provider_connections(
    id,account_id,name,preset_id,protocol,api_root,
    encrypted_api_key,connection_fingerprint,status
  ) VALUES (
    v_ai,v_account,'SOF66 AI Model','sof66-ai-model','openai',
    'https://example.test/v1','encrypted-smoke-key',
    'sof66-model-provider-not-whatsapp','verified'
  );
  INSERT INTO public.ai_agents(id,account_id,slug,name,purpose,status)
  VALUES(v_agent,v_account,'sof66-consent-agent','SOF66 Agent','custom','active');
  INSERT INTO public.ai_agent_revisions(
    id,account_id,agent_id,revision_number,status,provider_connection_id,model
  ) VALUES (
    v_revision,v_account,v_agent,1,'published',v_ai,'smoke-model'
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
  ) VALUES
    (v_task,v_account,'coverage.sourcing',2,v_agent,v_revision,
     'manual','running','SOF66 consented OpenWA regression',
     jsonb_build_object('whatsappConnectionId',v_wa::text),
     'whatsapp',2,1,'sof66-consent-task','sof66-consent-correlation',v_user),
    (v_meta_task,v_account,'coverage.sourcing',1,v_agent,v_revision,
     'manual','running','SOF66 Meta template guard',
     jsonb_build_object('whatsappConnectionId',v_meta::text),
     'whatsapp',1,1,'sof66-meta-task','sof66-meta-correlation',v_user);

  INSERT INTO public.ai_agent_task_targets(
    id,account_id,task_id,contact_id,counterparty_role,
    status,conversation_id,attempt_count,idempotency_key
  ) VALUES
    (v_target,v_account,v_task,v_contact,'supplier',
     'in_progress',v_conv,1,'sof66-consent-target'),
    (v_cold_target,v_account,v_task,v_cold_contact,'supplier',
     'in_progress',v_cold_conv,1,'sof66-unapproved-target'),
    (v_meta_target,v_account,v_meta_task,v_meta_contact,'supplier',
     'in_progress',v_meta_conv,1,'sof66-meta-target');

  v_run:=public.create_agent_execution(
    v_account,v_conv,NULL,v_agent,v_revision,v_ai,NULL,
    'SOF66 consent','customer','outbound',v_task,v_target,
    'task_target','attempt:1','supplier','sof66-consent-run'
  );
  v_cold_run:=public.create_agent_execution(
    v_account,v_cold_conv,NULL,v_agent,v_revision,v_ai,NULL,
    'SOF66 no consent','customer','outbound',v_task,v_cold_target,
    'task_target','attempt:1','supplier','sof66-unapproved-run'
  );
  v_meta_run:=public.create_agent_execution(
    v_account,v_meta_conv,NULL,v_agent,v_revision,v_ai,NULL,
    'SOF66 Meta template','customer','outbound',v_meta_task,v_meta_target,
    'task_target','attempt:1','supplier','sof66-meta-run'
  );
  IF public.claim_agent_run(v_run,'sof66-worker',300)<>'claimed'
    OR public.claim_agent_run(v_cold_run,'sof66-worker',300)<>'claimed'
    OR public.claim_agent_run(v_meta_run,'sof66-worker',300)<>'claimed' THEN
    RAISE EXCEPTION 'SOF66 outbound Run setup failed';
  END IF;
  IF (SELECT provider_connection_id FROM public.ai_agent_runs WHERE id=v_run)=v_wa THEN
    RAISE EXCEPTION 'SOF66 regression requires AI model provider != WhatsApp session';
  END IF;

  -- No approval: stale text must fail closed without any reservation.
  v_result:=public.reserve_expected_provider_agent_task_outbound_message(
    v_run,'coverage.sourcing_message',2,'text',
    'TEST: Request 400 SAR coverage',NULL,NULL,'[]'::jsonb,
    0,60,1440,true,'openwa'
  );
  IF v_result->>'reason'<>'connection_session_window_closed' THEN
    RAISE EXCEPTION 'SOF66 stale unapproved text was permitted: %',v_result;
  END IF;

  -- Wrong-session approval cannot authorize session A.
  v_hash:=encode(extensions.digest(
    'openwa-pilot:v1:'||v_account::text||':'||v_wa_other::text||
    ':967700001170@c.us','sha256'),'hex');
  INSERT INTO public.whatsapp_openwa_pilot_allowlist(
    account_id,connection_id,recipient_hash,workload,active,approved_by,
    expires_at,consent_basis,consent_attested_at
  ) VALUES (
    v_account,v_wa_other,v_hash,'agent',true,v_user,
    now()+interval '4 hours','phone_call',now()
  );
  IF public.openwa_agent_phone_call_authorized(
    v_account,v_wa,v_contact,v_conv) THEN
    RAISE EXCEPTION 'SOF66 foreign session grant leaked';
  END IF;
  v_result:=public.reserve_expected_provider_agent_task_outbound_message(
    v_run,'coverage.sourcing_message',2,'text',
    'TEST: Request 400 SAR coverage',NULL,NULL,'[]'::jsonb,
    0,60,1440,true,'openwa'
  );
  IF v_result->>'reason'<>'connection_session_window_closed' THEN
    RAISE EXCEPTION 'SOF66 wrong-session grant accepted: %',v_result;
  END IF;

  v_hash:=encode(extensions.digest(
    'openwa-pilot:v1:'||v_account::text||':'||v_wa::text||
    ':967700001170@c.us','sha256'),'hex');
  INSERT INTO public.whatsapp_openwa_pilot_allowlist(
    account_id,connection_id,recipient_hash,workload,active,approved_by,
    expires_at,consent_basis,consent_attested_at
  ) VALUES (
    v_account,v_wa,v_hash,'manual',true,v_user,
    now()+interval '4 hours','phone_call',now()
  );
  v_result:=public.reserve_expected_provider_agent_task_outbound_message(
    v_run,'coverage.sourcing_message',2,'text',
    'TEST: Request 400 SAR coverage',NULL,NULL,'[]'::jsonb,
    0,60,1440,true,'openwa'
  );
  IF v_result->>'reason'<>'connection_session_window_closed' THEN
    RAISE EXCEPTION 'SOF66 manual workload grant accepted by Agent: %',v_result;
  END IF;
  UPDATE public.whatsapp_openwa_pilot_allowlist
    SET workload='agent',consent_attested_at=NULL
    WHERE account_id=v_account AND connection_id=v_wa AND recipient_hash=v_hash;
  v_result:=public.reserve_expected_provider_agent_task_outbound_message(
    v_run,'coverage.sourcing_message',2,'text',
    'TEST: Request 400 SAR coverage',NULL,NULL,'[]'::jsonb,
    0,60,1440,true,'openwa'
  );
  IF v_result->>'reason'<>'connection_session_window_closed' THEN
    RAISE EXCEPTION 'SOF66 missing attestation accepted: %',v_result;
  END IF;
  UPDATE public.whatsapp_openwa_pilot_allowlist
    SET consent_attested_at=now(),approved_at=now()-interval '5 hours',
        expires_at=now()-interval '1 second'
    WHERE account_id=v_account AND connection_id=v_wa AND recipient_hash=v_hash;
  v_result:=public.reserve_expected_provider_agent_task_outbound_message(
    v_run,'coverage.sourcing_message',2,'text',
    'TEST: Request 400 SAR coverage',NULL,NULL,'[]'::jsonb,
    0,60,1440,true,'openwa'
  );
  IF v_result->>'reason'<>'connection_session_window_closed' THEN
    RAISE EXCEPTION 'SOF66 expired consent accepted: %',v_result;
  END IF;

  UPDATE public.whatsapp_openwa_pilot_allowlist
    SET approved_at=now(),expires_at=now()+interval '4 hours'
    WHERE account_id=v_account AND connection_id=v_wa AND recipient_hash=v_hash;
  UPDATE public.whatsapp_connection_guardrails
    SET manual_paused=true WHERE connection_id=v_wa;
  v_result:=public.reserve_expected_provider_agent_task_outbound_message(
    v_run,'coverage.sourcing_message',2,'text',
    'TEST: Request 400 SAR coverage',NULL,NULL,'[]'::jsonb,
    0,60,1440,true,'openwa'
  );
  IF v_result->>'reason'<>'connection_session_window_closed' THEN
    RAISE EXCEPTION 'SOF66 paused Pilot consent accepted: %',v_result;
  END IF;
  UPDATE public.whatsapp_connection_guardrails
    SET manual_paused=false WHERE connection_id=v_wa;

  -- Fix under test: exact active Agent grant on Task-pinned OpenWA session
  -- must override STALE inbound, despite the unrelated model provider UUID.
  IF public.openwa_agent_phone_call_authorized(
    v_account,v_ai,v_contact,v_conv) IS DISTINCT FROM false
    OR public.openwa_agent_phone_call_authorized(
      v_account,v_wa,v_contact,v_conv) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SOF66 test fixture lacks deliberate provider mismatch';
  END IF;
  v_result:=public.reserve_expected_provider_agent_task_outbound_message(
    v_run,'coverage.sourcing_message',2,'text',
    'TEST: Request 400 SAR coverage',NULL,NULL,'[]'::jsonb,
    0,60,1440,true,'openwa'
  );
  IF v_result->>'reserved'<>'true'
    OR v_result->>'session_window_active'<>'false'
    OR v_result->>'provider'<>'openwa'
    OR (v_result->>'connection_id')::uuid<>v_wa THEN
    RAISE EXCEPTION 'SOF66 valid phone consent denied by base reservation: %',v_result;
  END IF;
  v_reservation:=(v_result->>'reservation_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.ai_agent_task_outbound_messages
    WHERE id=v_reservation AND account_id=v_account
      AND provider='openwa' AND connection_id=v_wa
      AND status='reserved' AND session_window_active=false
  ) THEN RAISE EXCEPTION 'SOF66 reservation lost frozen OpenWA transport'; END IF;

  -- Claim only database reservation ownership. No WhatsApp transport invoked.
  v_result:=public.claim_bound_agent_task_outbound_message(
    v_reservation,'sof66-no-provider-dispatch',120
  );
  IF v_result->>'claimed'<>'true' THEN
    RAISE EXCEPTION 'SOF66 claim recheck wrongly rejected valid consent: %',v_result;
  END IF;
  v_result:=public.claim_bound_agent_task_outbound_message(
    v_reservation,'sof66-duplicate-owner',120
  );
  IF v_result->>'reason'<>'reconciliation_required' THEN
    RAISE EXCEPTION 'SOF66 duplicate send ownership was not blocked: %',v_result;
  END IF;

  -- Unapproved target on same session is still denied.
  v_result:=public.reserve_expected_provider_agent_task_outbound_message(
    v_cold_run,'coverage.sourcing_message',2,'text',
    'TEST: Other contact is not consented',NULL,NULL,'[]'::jsonb,
    0,60,1440,true,'openwa'
  );
  IF v_result->>'reason'<>'connection_session_window_closed' THEN
    RAISE EXCEPTION 'SOF66 unapproved same-session recipient escaped: %',v_result;
  END IF;

  -- Meta outbound is independent; no cold free-form text. Approved template
  -- stays accepted and is never routed through OpenWA.
  v_result:=public.reserve_expected_provider_agent_task_outbound_message(
    v_meta_run,'coverage.sourcing_message',1,'text',
    'TEST: Meta cold text',NULL,NULL,'[]'::jsonb,
    0,60,1440,true,'meta_cloud'
  );
  IF v_result->>'reason'<>'connection_session_window_closed' THEN
    RAISE EXCEPTION 'SOF66 Meta cold text was authorized by phone grant: %',v_result;
  END IF;
  INSERT INTO public.message_templates(
    user_id,account_id,name,category,language,body_text,status
  ) VALUES (
    v_user,v_account,'sof66_meta_template','Utility','ar',
    'TEST approved {{1}}','APPROVED'
  );
  v_result:=public.reserve_expected_provider_agent_task_outbound_message(
    v_meta_run,'coverage.sourcing_message',1,'template',
    NULL,'sof66_meta_template','ar','["400"]'::jsonb,
    0,60,1440,true,'meta_cloud'
  );
  IF v_result->>'reserved'<>'true' OR v_result->>'provider'<>'meta_cloud'
    OR (v_result->>'connection_id')::uuid<>v_meta THEN
    RAISE EXCEPTION 'SOF66 Meta approved-template compatibility broken: %',v_result;
  END IF;

  IF has_function_privilege('authenticated',
       'public.reserve_agent_task_outbound_message(uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean)','EXECUTE')
    OR has_function_privilege('anon',
       'public.reserve_agent_task_outbound_message(uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'SOF66 base reservation RPC privilege leak';
  END IF;
  RAISE NOTICE 'SOF66 exact transport consent smoke passed (no send, rollback)';
END $smoke$;
ROLLBACK;
