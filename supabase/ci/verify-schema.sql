-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- FX V2 persistence + concurrency primitives (079-080).
  IF to_regclass('public.account_exchange_settings') IS NULL
     OR to_regclass('public.exchange_rate_pairs') IS NULL
     OR to_regclass('public.exchange_rate_versions') IS NULL
     OR to_regclass('public.exchange_trade_requests') IS NULL THEN
    RAISE EXCEPTION 'FX V2 tables are missing — migrations 079-080 did not apply';
  END IF;

  IF to_regprocedure(
    'public.publish_exchange_rate_pair_version_v2(uuid,uuid,bigint,numeric,numeric,text,uuid,text,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'publish_exchange_rate_pair_version_v2 is missing';
  END IF;
  IF to_regprocedure(
    'public.create_exchange_trade_request_v2(uuid,uuid,text,text,numeric,text,uuid,uuid,uuid,jsonb)'
  ) IS NULL THEN
    RAISE EXCEPTION 'create_exchange_trade_request_v2 is missing';
  END IF;
  IF to_regprocedure(
    'public.decide_exchange_trade_request_v2(uuid,uuid,text,text,uuid,text,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'decide_exchange_trade_request_v2 is missing';
  END IF;
  IF to_regprocedure(
    'public.complete_exchange_trade_request_v2(uuid,uuid,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'complete_exchange_trade_request_v2 is missing';
  END IF;
  IF to_regprocedure(
    'public.cancel_exchange_trade_request_v2(uuid,uuid,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'cancel_exchange_trade_request_v2 is missing';
  END IF;

  -- FX V2 customer lifecycle outbox (084).
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'customer_intent_notifications'
      AND column_name = 'fx_trade_request_id'
  ) THEN
    RAISE EXCEPTION 'FX V2 customer outbox source column is missing — migration 084 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'exchange_trade_requests_customer_lifecycle_event'
      AND tgrelid = 'public.exchange_trade_requests'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'FX V2 customer lifecycle trigger is missing — migration 084 did not apply';
  END IF;

  -- Subject-scoped active Business Event claim (105).
  IF to_regprocedure(
    'public.claim_business_event_delivery_v2(uuid,text,text,text,integer)'
  ) IS NULL THEN
    RAISE EXCEPTION 'claim_business_event_delivery_v2 is missing — migration 105 did not apply';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.claim_business_event_delivery_v2(uuid,text,text,text,integer)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.claim_business_event_delivery_v2(uuid,text,text,text,integer)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.claim_business_event_delivery_v2(uuid,text,text,text,integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'claim_business_event_delivery_v2 privileges are unsafe';
  END IF;

  -- Coverage controlled customer Business Event cutover (106).
  IF to_regprocedure(
    'public.inspect_coverage_business_event_cutover_readiness(uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'Coverage cutover readiness RPC is missing — migration 106 did not apply';
  END IF;

  IF to_regprocedure(
    'public.set_coverage_business_event_delivery_mode(uuid,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'Coverage cutover mode RPC is missing — migration 106 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'coverage_offers_business_event_zz_route'
      AND tgrelid = 'public.coverage_offers'::regclass
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'coverage_requests_business_event_zz_route'
      AND tgrelid = 'public.coverage_requests'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Coverage route triggers are missing — migration 106 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'zz_customer_intent_notifications_business_event_sent_sync'
      AND tgrelid = 'public.customer_intent_notifications'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Late legacy Business Event sent-state sync trigger is missing';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.inspect_coverage_business_event_cutover_readiness(uuid)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.inspect_coverage_business_event_cutover_readiness(uuid)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.inspect_coverage_business_event_cutover_readiness(uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Coverage cutover readiness RPC privileges are unsafe';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.set_coverage_business_event_delivery_mode(uuid,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.set_coverage_business_event_delivery_mode(uuid,text)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.set_coverage_business_event_delivery_mode(uuid,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Coverage cutover mode RPC privileges are unsafe';
  END IF;


  -- Intents controlled customer Business Event cutover (107).
  IF to_regprocedure(
    'public.inspect_intents_business_event_cutover_readiness(uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'Intents cutover readiness RPC is missing — migration 107 did not apply';
  END IF;

  IF to_regprocedure(
    'public.set_intents_business_event_delivery_mode(uuid,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'Intents cutover mode RPC is missing — migration 107 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'customer_intents_business_event_zz_route'
      AND tgrelid = 'public.customer_intents'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Intents route trigger is missing — migration 107 did not apply';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.inspect_intents_business_event_cutover_readiness(uuid)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.inspect_intents_business_event_cutover_readiness(uuid)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.inspect_intents_business_event_cutover_readiness(uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Intents cutover readiness RPC privileges are unsafe';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.set_intents_business_event_delivery_mode(uuid,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.set_intents_business_event_delivery_mode(uuid,text)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.set_intents_business_event_delivery_mode(uuid,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Intents cutover mode RPC privileges are unsafe';
  END IF;

  -- Agent Task / Outreach persistence foundation (109).
  IF to_regclass('public.ai_agent_tasks') IS NULL
     OR to_regclass('public.ai_agent_task_targets') IS NULL
     OR to_regclass('public.ai_agent_task_events') IS NULL THEN
    RAISE EXCEPTION 'Agent Task tables are missing — migration 109 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.ai_agent_tasks'::regclass
      AND relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.ai_agent_task_targets'::regclass
      AND relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.ai_agent_task_events'::regclass
      AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'Agent Task RLS is not enabled on every task table';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_agent_runs'
      AND column_name = 'inbound_message_id'
      AND is_nullable <> 'YES'
  ) THEN
    RAISE EXCEPTION 'ai_agent_runs.inbound_message_id must be nullable after migration 109';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_agent_runs'
      AND column_name = 'run_mode'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_agent_runs'
      AND column_name = 'task_id'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_agent_runs'
      AND column_name = 'task_target_id'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_agent_runs'
      AND column_name = 'trigger_type'
  ) THEN
    RAISE EXCEPTION 'Generic agent execution columns are missing from ai_agent_runs';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'ai_agent_runs'
      AND indexname = 'ai_agent_runs_inbound_message_id_key'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
  ) THEN
    RAISE EXCEPTION 'Inbound-message uniqueness invariant is missing after migration 109';
  END IF;

  IF to_regprocedure(
    'public.create_agent_run(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'Legacy create_agent_run compatibility RPC is missing';
  END IF;

  IF to_regprocedure(
    'public.create_agent_execution(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,uuid,text,text,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'create_agent_execution is missing — migration 109 did not apply';
  END IF;

  IF to_regprocedure(
    'public.append_agent_task_event(uuid,uuid,uuid,uuid,text,text,text,jsonb)'
  ) IS NULL THEN
    RAISE EXCEPTION 'append_agent_task_event is missing — migration 109 did not apply';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.create_agent_execution(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,uuid,text,text,text,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.create_agent_execution(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,uuid,text,text,text,text)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.create_agent_execution(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,uuid,text,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'create_agent_execution privileges are unsafe';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.append_agent_task_event(uuid,uuid,uuid,uuid,text,text,text,jsonb)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.append_agent_task_event(uuid,uuid,uuid,uuid,text,text,text,jsonb)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.append_agent_task_event(uuid,uuid,uuid,uuid,text,text,text,jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'append_agent_task_event privileges are unsafe';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ai_agent_task_events'
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) THEN
    RAISE EXCEPTION 'ai_agent_task_events must remain append-only for authenticated clients';
  END IF;

  -- Agent Task Orchestrator durability (110).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ai_agent_tasks'
      AND column_name='available_at' AND is_nullable='NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ai_agent_tasks'
      AND column_name='lease_expires_at'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ai_agent_tasks'
      AND column_name='claimed_by'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ai_agent_task_targets'
      AND column_name='available_at' AND is_nullable='NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ai_agent_task_targets'
      AND column_name='lease_expires_at'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ai_agent_task_targets'
      AND column_name='claimed_by'
  ) THEN
    RAISE EXCEPTION 'Agent Task Orchestrator lease/scheduling columns are missing';
  END IF;

  IF to_regprocedure('public.claim_next_agent_task(text,integer)') IS NULL
     OR to_regprocedure('public.claim_next_agent_task_target(uuid,text,integer)') IS NULL
     OR to_regprocedure('public.release_agent_task_claim(uuid,text,integer)') IS NULL
     OR to_regprocedure('public.create_claimed_agent_task_execution(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.retry_agent_task_target_claim(uuid,uuid,text,text,integer)') IS NULL
     OR to_regprocedure('public.schedule_agent_task_target(uuid,uuid,timestamptz,text)') IS NULL
     OR to_regprocedure('public.pause_agent_task(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.resume_agent_task(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.cancel_agent_task(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.sweep_agent_task_claims(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'Agent Task Orchestrator RPC surface is incomplete';
  END IF;

  IF has_function_privilege(
       'anon','public.claim_next_agent_task(text,integer)','EXECUTE'
     )
     OR has_function_privilege(
       'authenticated','public.claim_next_agent_task(text,integer)','EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role','public.claim_next_agent_task(text,integer)','EXECUTE'
     ) THEN
    RAISE EXCEPTION 'claim_next_agent_task privileges are unsafe';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.create_claimed_agent_task_execution(uuid,uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.create_claimed_agent_task_execution(uuid,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'create_claimed_agent_task_execution privileges are unsafe';
  END IF;

  -- Agent Target Resolution / Eligibility (111).
  IF to_regclass('public.ai_outreach_contact_controls') IS NULL THEN
    RAISE EXCEPTION 'ai_outreach_contact_controls is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid='public.ai_outreach_contact_controls'::regclass
      AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'ai_outreach_contact_controls RLS is disabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='ai_agent_task_targets'
      AND column_name='resolver_key'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='ai_agent_task_targets'
      AND column_name='resolver_version'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='ai_agent_task_targets'
      AND column_name='eligibility_snapshot'
  ) THEN
    RAISE EXCEPTION 'Target resolver audit columns are missing';
  END IF;

  IF to_regprocedure(
    'public.materialize_agent_task_contact_target(uuid,uuid,text,text,integer,uuid[],uuid[],integer,integer,integer,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'materialize_agent_task_contact_target is missing';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.materialize_agent_task_contact_target(uuid,uuid,text,text,integer,uuid[],uuid[],integer,integer,integer,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.materialize_agent_task_contact_target(uuid,uuid,text,text,integer,uuid[],uuid[],integer,integer,integer,text)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.materialize_agent_task_contact_target(uuid,uuid,text,text,integer,uuid[],uuid[],integer,integer,integer,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Target materialization RPC privileges are unsafe';
  END IF;

  -- Agent Task Outbound Messaging Policy (112).
  IF to_regclass('public.ai_agent_task_outbound_messages') IS NULL THEN
    RAISE EXCEPTION 'ai_agent_task_outbound_messages is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid='public.ai_agent_task_outbound_messages'::regclass
      AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'ai_agent_task_outbound_messages RLS is disabled';
  END IF;

  IF to_regprocedure(
    'public.reserve_agent_task_outbound_message(uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean)'
  ) IS NULL
     OR to_regprocedure(
       'public.claim_agent_task_outbound_message(uuid,text,integer)'
     ) IS NULL
     OR to_regprocedure(
       'public.complete_agent_task_outbound_message(uuid,text,uuid,text,integer,integer)'
     ) IS NULL
     OR to_regprocedure(
       'public.mark_agent_task_outbound_reconciliation(uuid,text,text,text)'
     ) IS NULL
     OR to_regprocedure(
       'public.fail_agent_task_outbound_run(uuid,text,integer)'
     ) IS NULL
     OR to_regprocedure(
       'public.sweep_agent_task_outbound_messages(timestamptz)'
     ) IS NULL THEN
    RAISE EXCEPTION 'Agent Task outbound messaging RPC surface is incomplete';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.reserve_agent_task_outbound_message(uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.reserve_agent_task_outbound_message(uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.reserve_agent_task_outbound_message(uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Outbound reservation RPC privileges are unsafe';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname='public'
      AND tablename='ai_agent_task_outbound_messages'
      AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
  ) THEN
    RAISE EXCEPTION 'Authenticated clients must not mutate outbound reservations directly';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
