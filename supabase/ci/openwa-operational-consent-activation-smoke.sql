-- OW14-W07-02: synthetic only; all fixtures rollback. No actual session,
-- webhook, WhatsApp send, remote Supabase or Production mutation.
BEGIN;

DO $schema$
DECLARE
  v_function text;
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'whatsapp_openwa_policy_versions',
    'whatsapp_openwa_consent_state',
    'whatsapp_openwa_consent_audit',
    'whatsapp_openwa_activation_state',
    'whatsapp_openwa_activation_audit'
  ] LOOP
    IF to_regclass('public.'||v_table) IS NULL THEN
      RAISE EXCEPTION 'Missing W07 table: %',v_table;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class
      WHERE oid=to_regclass('public.'||v_table)) THEN
      RAISE EXCEPTION 'W07 table missing RLS: %',v_table;
    END IF;
    IF has_table_privilege('anon','public.'||v_table,'SELECT')
      OR has_table_privilege('authenticated','public.'||v_table,'SELECT')
      OR has_table_privilege('authenticated','public.'||v_table,'INSERT')
      OR has_table_privilege('authenticated','public.'||v_table,'UPDATE')
      OR has_table_privilege('service_role','public.'||v_table,'DELETE')
      OR has_table_privilege('service_role','public.'||v_table,'TRUNCATE')
    THEN RAISE EXCEPTION 'W07 table privileges are unsafe: %',v_table; END IF;
  END LOOP;

  IF has_table_privilege('service_role','public.whatsapp_openwa_policy_versions','INSERT')
    OR has_table_privilege('service_role','public.whatsapp_openwa_policy_versions','UPDATE')
    OR has_table_privilege('service_role','public.whatsapp_openwa_consent_audit','UPDATE')
    OR has_table_privilege('service_role','public.whatsapp_openwa_activation_audit','UPDATE')
    OR NOT has_table_privilege('service_role','public.whatsapp_openwa_consent_audit','INSERT')
    OR NOT has_table_privilege('service_role','public.whatsapp_openwa_activation_audit','INSERT')
  THEN RAISE EXCEPTION 'W07 approval registry or audit append-only boundary failed'; END IF;

  IF EXISTS (SELECT 1 FROM public.whatsapp_openwa_policy_versions) THEN
    RAISE EXCEPTION 'No policy should be approved or seeded by W07-02';
  END IF;
  IF EXISTS (SELECT 1 FROM public.whatsapp_openwa_consent_state)
     OR EXISTS (SELECT 1 FROM public.whatsapp_openwa_activation_state)
  THEN RAISE EXCEPTION 'W07-02 unexpectedly activated a real account'; END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.set_openwa_operational_consent(uuid,uuid,text,text,text,bigint,uuid)',
    'public.set_openwa_operational_activation(uuid,uuid,uuid,text,bigint,uuid)'
  ] LOOP
    IF to_regprocedure(v_function) IS NULL THEN
      RAISE EXCEPTION 'Missing W07 transaction RPC: %',v_function;
    END IF;
    IF (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid=to_regprocedure(v_function))
      OR has_function_privilege('anon',v_function,'EXECUTE')
      OR has_function_privilege('authenticated',v_function,'EXECUTE')
      OR NOT has_function_privilege('service_role',v_function,'EXECUTE')
    THEN RAISE EXCEPTION 'Unsafe W07 function execute rights: %',v_function; END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname='openwa_activation_state_connection_fk'
      AND conrelid='public.whatsapp_openwa_activation_state'::regclass)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conname='openwa_activation_audit_account_connection_fk'
        AND conrelid='public.whatsapp_openwa_activation_audit'::regclass)
  THEN RAISE EXCEPTION 'W07 activation lacks composite tenant foreign keys'; END IF;
END $schema$;

DO $fixture$
DECLARE
  v_owner_a uuid:=gen_random_uuid();
  v_admin_a uuid:=gen_random_uuid();
  v_agent_a uuid:=gen_random_uuid();
  v_viewer_a uuid:=gen_random_uuid();
  v_owner_b uuid:=gen_random_uuid();
  v_account_a uuid;
  v_account_b uuid;
  v_connection_a uuid:=gen_random_uuid();
  v_connection_b uuid:=gen_random_uuid();
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    (v_owner_a,'w07-owner-a-'||v_owner_a::text||'@example.test','{"full_name":"W07 Owner A"}'::jsonb),
    (v_admin_a,'w07-admin-a-'||v_admin_a::text||'@example.test','{"full_name":"W07 Admin A"}'::jsonb),
    (v_agent_a,'w07-agent-a-'||v_agent_a::text||'@example.test','{"full_name":"W07 Agent A"}'::jsonb),
    (v_viewer_a,'w07-viewer-a-'||v_viewer_a::text||'@example.test','{"full_name":"W07 Viewer A"}'::jsonb),
    (v_owner_b,'w07-owner-b-'||v_owner_b::text||'@example.test','{"full_name":"W07 Owner B"}'::jsonb);

  SELECT account_id INTO STRICT v_account_a FROM public.profiles WHERE user_id=v_owner_a;
  SELECT account_id INTO STRICT v_account_b FROM public.profiles WHERE user_id=v_owner_b;
  UPDATE public.profiles SET account_id=v_account_a,account_role='admin' WHERE user_id=v_admin_a;
  UPDATE public.profiles SET account_id=v_account_a,account_role='agent' WHERE user_id=v_agent_a;
  UPDATE public.profiles SET account_id=v_account_a,account_role='viewer' WHERE user_id=v_viewer_a;

  INSERT INTO public.whatsapp_connections(id,account_id,provider,status,session_id)
    VALUES
    (v_connection_a,v_account_a,'openwa','ready','w07-ci-session-a'),
    (v_connection_b,v_account_b,'openwa','ready','w07-ci-session-b');

  PERFORM set_config('w07.account_a',v_account_a::text,true);
  PERFORM set_config('w07.account_b',v_account_b::text,true);
  PERFORM set_config('w07.owner_a',v_owner_a::text,true);
  PERFORM set_config('w07.owner_b',v_owner_b::text,true);
  PERFORM set_config('w07.admin_a',v_admin_a::text,true);
  PERFORM set_config('w07.agent_a',v_agent_a::text,true);
  PERFORM set_config('w07.viewer_a',v_viewer_a::text,true);
  PERFORM set_config('w07.connection_a',v_connection_a::text,true);
  PERFORM set_config('w07.connection_b',v_connection_b::text,true);
END $fixture$;

-- Test in the actual server role, not as the powerful migration owner.
SET LOCAL ROLE service_role;

DO $no_approved_policy$
DECLARE
  v_result jsonb;
BEGIN
  SELECT public.set_openwa_operational_consent(
    current_setting('w07.account_a')::uuid,current_setting('w07.owner_a')::uuid,
    'accept','w07-ci-only-policy-v1',repeat('a',64),0,gen_random_uuid())
    INTO v_result;
  IF v_result->>'reason'<>'policy_not_approved' THEN
    RAISE EXCEPTION 'An unapproved policy was accepted: %',v_result;
  END IF;

  SELECT public.set_openwa_operational_activation(
    current_setting('w07.account_a')::uuid,current_setting('w07.connection_a')::uuid,
    current_setting('w07.admin_a')::uuid,'enabled',0,gen_random_uuid())
    INTO v_result;
  IF v_result->>'reason'<>'consent_required' THEN
    RAISE EXCEPTION 'An OpenWA connection activated without consent: %',v_result;
  END IF;
END $no_approved_policy$;

RESET ROLE;

-- Synthetic approved policy strictly inside ROLLBACK; no policy is published
-- by migration 204. Only the migration owner can populate this registry.
INSERT INTO public.whatsapp_openwa_policy_versions
  (version,digest,approved_at,approval_ref,is_current)
VALUES ('w07-ci-only-policy-v1',repeat('a',64),clock_timestamp(),
        'W07-ci-rollback-only',true);

SET LOCAL ROLE service_role;

DO $lifecycle$
DECLARE
  v_account uuid:=current_setting('w07.account_a')::uuid;
  v_other_account uuid:=current_setting('w07.account_b')::uuid;
  v_connection uuid:=current_setting('w07.connection_a')::uuid;
  v_other_connection uuid:=current_setting('w07.connection_b')::uuid;
  v_owner uuid:=current_setting('w07.owner_a')::uuid;
  v_other_owner uuid:=current_setting('w07.owner_b')::uuid;
  v_admin uuid:=current_setting('w07.admin_a')::uuid;
  v_agent uuid:=current_setting('w07.agent_a')::uuid;
  v_viewer uuid:=current_setting('w07.viewer_a')::uuid;
  v_consent_request uuid:=gen_random_uuid();
  v_activation_request uuid:=gen_random_uuid();
  v_result jsonb;
  v_old_event uuid;
  v_new_event uuid;
  v_count bigint;
  v_fk_blocked boolean:=false;
  v_audit_write_blocked boolean:=false;
BEGIN
  -- Admin/agent/viewer cannot accept, and owner of B cannot accept for A.
  FOREACH v_admin IN ARRAY ARRAY[v_admin,v_agent,v_viewer,v_other_owner] LOOP
    SELECT public.set_openwa_operational_consent(
      v_account,v_admin,'accept','w07-ci-only-policy-v1',repeat('a',64),
      0,gen_random_uuid()) INTO v_result;
    IF v_result->>'reason'<>'actor_forbidden' THEN
      RAISE EXCEPTION 'Non-owner accepted policy: %',v_result;
    END IF;
  END LOOP;
  v_admin:=current_setting('w07.admin_a')::uuid;

  SELECT public.set_openwa_operational_consent(
    v_account,v_owner,'accept','w07-ci-only-policy-v1',repeat('b',64),
    0,gen_random_uuid()) INTO v_result;
  IF v_result->>'reason'<>'policy_not_approved' THEN
    RAISE EXCEPTION 'Wrong policy digest was accepted: %',v_result;
  END IF;

  SELECT public.set_openwa_operational_consent(
    v_account,v_owner,'accept','w07-ci-only-policy-v1',repeat('a',64),
    0,v_consent_request) INTO v_result;
  IF v_result->>'updated'<>'true' OR v_result->>'revision'<>'1' THEN
    RAISE EXCEPTION 'Owner acceptance failed: %',v_result;
  END IF;

  SELECT accepted_event_id INTO STRICT v_old_event
    FROM public.whatsapp_openwa_consent_state WHERE account_id=v_account;

  -- Duplicate request id cannot create a second audit or advance revision.
  SELECT public.set_openwa_operational_consent(
    v_account,v_owner,'accept','w07-ci-only-policy-v1',repeat('a',64),
    0,v_consent_request) INTO v_result;
  IF v_result->>'idempotent'<>'true' THEN
    RAISE EXCEPTION 'Duplicate consent request was not idempotent: %',v_result;
  END IF;

  SELECT public.set_openwa_operational_consent(
    v_account,v_owner,'revoke',NULL,NULL,0,gen_random_uuid()) INTO v_result;
  IF v_result->>'reason'<>'revision_conflict' THEN
    RAISE EXCEPTION 'Stale expected consent revision allowed: %',v_result;
  END IF;

  -- Account B has no consent and cannot borrow an A-owned connection.
  SELECT public.set_openwa_operational_activation(
    v_other_account,v_connection,v_other_owner,'enabled',0,gen_random_uuid())
    INTO v_result;
  IF v_result->>'reason'<>'connection_scope_mismatch' THEN
    RAISE EXCEPTION 'Cross-account activation escaped scoped lookup: %',v_result;
  END IF;

  SELECT public.set_openwa_operational_activation(
    v_account,v_other_connection,v_admin,'enabled',0,gen_random_uuid())
    INTO v_result;
  IF v_result->>'reason'<>'connection_scope_mismatch' THEN
    RAISE EXCEPTION 'Wrong-account connection escaped scoped lookup: %',v_result;
  END IF;

  SELECT public.set_openwa_operational_activation(
    v_account,v_connection,v_agent,'enabled',0,gen_random_uuid())
    INTO v_result;
  IF v_result->>'reason'<>'actor_forbidden' THEN
    RAISE EXCEPTION 'Agent activated OpenWA: %',v_result;
  END IF;
  SELECT public.set_openwa_operational_activation(
    v_account,v_connection,v_viewer,'enabled',0,gen_random_uuid())
    INTO v_result;
  IF v_result->>'reason'<>'actor_forbidden' THEN
    RAISE EXCEPTION 'Viewer activated OpenWA: %',v_result;
  END IF;

  SELECT public.set_openwa_operational_activation(
    v_account,v_connection,v_admin,'enabled',0,v_activation_request)
    INTO v_result;
  IF v_result->>'updated'<>'true' OR v_result->>'revision'<>'1' THEN
    RAISE EXCEPTION 'Authorized admin activation failed: %',v_result;
  END IF;
  SELECT public.set_openwa_operational_activation(
    v_account,v_connection,v_admin,'enabled',0,v_activation_request)
    INTO v_result;
  IF v_result->>'idempotent'<>'true' THEN
    RAISE EXCEPTION 'Duplicate activation request was not idempotent: %',v_result;
  END IF;

  SELECT public.set_openwa_operational_activation(
    v_account,v_connection,v_admin,'suspended',0,gen_random_uuid()) INTO v_result;
  IF v_result->>'reason'<>'revision_conflict' THEN
    RAISE EXCEPTION 'Concurrent activation revision was not fenced: %',v_result;
  END IF;

  SELECT public.set_openwa_operational_consent(
    v_account,v_owner,'revoke',NULL,NULL,1,gen_random_uuid()) INTO v_result;
  IF v_result->>'updated'<>'true' OR v_result->>'status'<>'revoked' THEN
    RAISE EXCEPTION 'Owner revocation failed: %',v_result;
  END IF;
  SELECT public.set_openwa_operational_activation(
    v_account,v_connection,v_admin,'enabled',1,gen_random_uuid()) INTO v_result;
  IF v_result->>'reason'<>'consent_required' THEN
    RAISE EXCEPTION 'Revoked consent still authorized activation: %',v_result;
  END IF;

  -- Re-accepting the exact same version creates a NEW accepted event.
  -- Previously enabled state must no longer bind the current acceptance.
  SELECT public.set_openwa_operational_consent(
    v_account,v_owner,'accept','w07-ci-only-policy-v1',repeat('a',64),
    2,gen_random_uuid()) INTO v_result;
  IF v_result->>'updated'<>'true' THEN
    RAISE EXCEPTION 'Owner reacceptance failed: %',v_result;
  END IF;
  SELECT accepted_event_id INTO STRICT v_new_event
    FROM public.whatsapp_openwa_consent_state WHERE account_id=v_account;
  IF v_new_event=v_old_event THEN
    RAISE EXCEPTION 'Reacceptance reused old consent event';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_openwa_activation_state
    WHERE account_id=v_account AND connection_id=v_connection
      AND status='enabled' AND consent_event_id=v_old_event
      AND consent_event_id<>v_new_event
  ) THEN RAISE EXCEPTION 'Activation is not fenced to an exact consent event'; END IF;

  -- Explicit admin reactivation binds to the newest acceptance event.
  SELECT public.set_openwa_operational_activation(
    v_account,v_connection,v_admin,'enabled',1,gen_random_uuid()) INTO v_result;
  IF v_result->>'updated'<>'true' OR v_result->>'revision'<>'2' THEN
    RAISE EXCEPTION 'Explicit reactivation did not rebind consent: %',v_result;
  END IF;

  SELECT count(*) INTO v_count FROM public.whatsapp_openwa_consent_audit
    WHERE account_id=v_account;
  IF v_count<>3 THEN RAISE EXCEPTION 'Unexpected consent audit rows: %',v_count; END IF;
  SELECT count(*) INTO v_count FROM public.whatsapp_openwa_activation_audit
    WHERE account_id=v_account AND connection_id=v_connection;
  IF v_count<>2 THEN RAISE EXCEPTION 'Unexpected activation audit rows: %',v_count; END IF;

  -- Composite FK blocks forged connection/account row even for service role.
  BEGIN
    INSERT INTO public.whatsapp_openwa_activation_state(
      account_id,connection_id,status,revision,updated_by)
    VALUES (v_other_account,v_connection,'disabled',1,v_other_owner);
  EXCEPTION WHEN foreign_key_violation THEN v_fk_blocked:=true;
  END;
  IF NOT v_fk_blocked THEN RAISE EXCEPTION 'Tenant-composite FK bypassed'; END IF;

  -- service_role cannot rewrite or delete existing audit evidence.
  BEGIN
    UPDATE public.whatsapp_openwa_consent_audit SET action='revoke'
      WHERE account_id=v_account;
  EXCEPTION WHEN insufficient_privilege THEN v_audit_write_blocked:=true;
  END;
  IF NOT v_audit_write_blocked THEN RAISE EXCEPTION 'Consent audit is mutable'; END IF;

  RAISE NOTICE 'W07-02 owner consent + admin activation + revocation + audit test passed';
END $lifecycle$;

-- Browser/agent roles cannot read audit tables or call service-only functions.
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $client_acl$
DECLARE v_blocked boolean:=false;
BEGIN
  BEGIN
    PERFORM * FROM public.whatsapp_openwa_consent_state;
  EXCEPTION WHEN insufficient_privilege THEN v_blocked:=true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'Authenticated user can read confidential policy state';
  END IF;
END $client_acl$;

RESET ROLE;
ROLLBACK;
