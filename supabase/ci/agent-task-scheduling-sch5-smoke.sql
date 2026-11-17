-- SCH-5: transactional, zero-send regression for exact Business Event match,
-- duplicate callbacks, tenant isolation, pause/resume and redacted queue health.
BEGIN;
DO $$
DECLARE
  v_user_a uuid := '00000000-0000-4000-8000-000000000195';
  v_user_b uuid := '00000000-0000-4000-8000-000000000196';
  v_account_a uuid;
  v_account_b uuid;
  v_agent_a uuid := gen_random_uuid();
  v_agent_b uuid := gen_random_uuid();
  v_subject uuid := gen_random_uuid();
  v_wrong uuid := gen_random_uuid();
  v_event_id uuid := gen_random_uuid();
  v_event_new uuid := gen_random_uuid();
  v_foreign uuid := gen_random_uuid();
  v_trigger_a uuid;
  v_trigger_b uuid;
  v_result jsonb;
  v_health_a jsonb;
  v_health_b jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users WHERE id IN (v_user_a,v_user_b)) THEN
    RAISE EXCEPTION 'SCH5_FIXTURE_COLLISION';
  END IF;
  INSERT INTO auth.users(id,email,raw_user_meta_data)
  VALUES
    (v_user_a,'sch5-event-a@example.test','{"full_name":"SCH5 A"}'::jsonb),
    (v_user_b,'sch5-event-b@example.test','{"full_name":"SCH5 B"}'::jsonb);
  SELECT account_id INTO STRICT v_account_a FROM public.profiles WHERE user_id=v_user_a;
  SELECT account_id INTO STRICT v_account_b FROM public.profiles WHERE user_id=v_user_b;

  INSERT INTO public.ai_agents(id,account_id,slug,name,purpose,status)
  VALUES (v_agent_a,v_account_a,'sch5-a','SCH5 A','custom','active'),
         (v_agent_b,v_account_b,'sch5-b','SCH5 B','custom','active');
  v_trigger_a:=public.create_agent_task_trigger(
    v_account_a,'coverage.sourcing',1,v_agent_a,'business_event',
    NULL,NULL,NULL,'coverage.request.approved',1,
    jsonb_build_object('coverageRequestId',v_subject),
    jsonb_build_object('subject_type','coverage_request','subject_id',v_subject::text),
    'sch5-account-a-event-policy-v1',v_user_a);
  v_trigger_b:=public.create_agent_task_trigger(
    v_account_b,'coverage.sourcing',1,v_agent_b,'schedule',
    'once',now()+interval '1 day',NULL,NULL,NULL,
    jsonb_build_object('coverageRequestId',v_wrong),'{}'::jsonb,
    'sch5-account-b-future-policy',v_user_b);
  -- Foreign events and wrong subjects may never become A's firings.
  INSERT INTO public.business_event_outbox(
    id,account_id,event_type,event_version,subject_type,subject_id,
    actor_type,actor_id,audience,channel,correlation_id,causation_id,
    payload,delivery_mode,status,dedupe_key
  ) VALUES
    (v_event_id,v_account_a,'coverage.request.approved',1,
     'coverage_request',v_subject::text,'system','sch5',
     'internal',NULL,'sch5-a',NULL,'{}'::jsonb,
     'shadow','pending','sch5-event-matched-a'),
    (v_foreign,v_account_b,'coverage.request.approved',1,
     'coverage_request',v_subject::text,'system','sch5',
     'internal',NULL,'sch5-b',NULL,'{}'::jsonb,
     'shadow','pending','sch5-event-foreign-b'),
    (gen_random_uuid(),v_account_a,'coverage.request.approved',1,
     'coverage_request',v_wrong::text,'system','sch5',
     'internal',NULL,'sch5-wrong',NULL,'{}'::jsonb,
     'shadow','pending','sch5-event-wrong-subject');

  v_result:=public.materialize_agent_task_trigger_firings(now(),20);
  IF (v_result->>'business_event_firings')::integer<>1 THEN
    RAISE EXCEPTION 'SCH5_WRONG_EVENT_ADMISSION: %',v_result;
  END IF;
  v_result:=public.materialize_agent_task_trigger_firings(now(),20);
  IF (v_result->>'business_event_firings')::integer<>0 THEN
    RAISE EXCEPTION 'SCH5_DUPLICATE_EVENT_MATERIALIZATION: %',v_result;
  END IF;
  IF (SELECT count(*) FROM public.ai_agent_task_trigger_firings
      WHERE account_id=v_account_a AND trigger_id=v_trigger_a
        AND business_event_id=v_event_id
        AND source_key='event:'||v_event_id::text)<>1 THEN
    RAISE EXCEPTION 'SCH5_EVENT_IDEMPOTENCY_MISSING';
  END IF;

  -- Account B's terminal failure cannot appear in the tenant A health reply.
  INSERT INTO public.ai_agent_task_trigger_firings(
    account_id,trigger_id,source_kind,source_key,scheduled_for,
    available_at,status,last_error
  ) VALUES (
    v_account_b,v_trigger_b,'schedule',
    'schedule:sch5-terminal-b',now(),now(),
    'dead','AGENT_TASK_TRIGGER_HANDLER_ERROR'
  );
  v_health_a:=public.inspect_agent_task_schedule_health(v_account_a);
  v_health_b:=public.inspect_agent_task_schedule_health(v_account_b);
  IF (v_health_a->>'backlog')::integer<>1
    OR (v_health_a->>'dead')::integer<>0
    OR (v_health_b->>'backlog')::integer<>0
    OR (v_health_b->>'dead')::integer<>1
    OR (v_health_b->>'enabledSchedules')::integer<>1 THEN
    RAISE EXCEPTION 'SCH5_CROSS_ACCOUNT_METRICS A=% B=%',v_health_a,v_health_b;
  END IF;

  -- Pausing must not materialize another event; resuming may backfill
  -- ONLY the matching event once, with its original source identity.
  IF NOT public.set_agent_task_trigger_status(v_account_a,v_trigger_a,'paused') THEN
    RAISE EXCEPTION 'SCH5_PAUSE_FAILED';
  END IF;
  INSERT INTO public.business_event_outbox(
    id,account_id,event_type,event_version,subject_type,subject_id,
    actor_type,actor_id,audience,channel,correlation_id,causation_id,
    payload,delivery_mode,status,dedupe_key
  ) VALUES (
    v_event_new,v_account_a,'coverage.request.approved',1,
    'coverage_request',v_subject::text,'system','sch5',
    'internal',NULL,'sch5-after-pause',NULL,'{}'::jsonb,
    'shadow','pending','sch5-event-after-pause');
  v_result:=public.materialize_agent_task_trigger_firings(now(),20);
  IF (v_result->>'business_event_firings')::integer<>0 THEN
    RAISE EXCEPTION 'SCH5_PAUSED_EVENT_RAN: %',v_result;
  END IF;
  IF NOT public.set_agent_task_trigger_status(v_account_a,v_trigger_a,'enabled') THEN
    RAISE EXCEPTION 'SCH5_RESUME_FAILED';
  END IF;
  v_result:=public.materialize_agent_task_trigger_firings(now(),20);
  IF (v_result->>'business_event_firings')::integer<>1 THEN
    RAISE EXCEPTION 'SCH5_RESUMED_EVENT_NOT_DEDUPED: %',v_result;
  END IF;
  IF (SELECT count(*) FROM public.ai_agent_task_trigger_firings
      WHERE account_id=v_account_a AND trigger_id=v_trigger_a)<>2 THEN
    RAISE EXCEPTION 'SCH5_SOURCE_COUNT_MISMATCH';
  END IF;
  IF has_function_privilege('authenticated',
       'public.materialize_agent_task_trigger_firings(timestamptz,integer)','EXECUTE')
    OR has_function_privilege('authenticated',
       'public.claim_next_agent_task_trigger_firing(text,integer)','EXECUTE')
    OR has_table_privilege('authenticated',
       'public.ai_agent_task_trigger_firings','SELECT') THEN
    RAISE EXCEPTION 'SCH5_PUBLIC_QUEUE_EXPOSURE';
  END IF;
  RAISE NOTICE 'PASS SCH5 event dedupe, tenant isolation, account-scoped metrics, pause/resume, grants — no send';
END $$;
ROLLBACK;
