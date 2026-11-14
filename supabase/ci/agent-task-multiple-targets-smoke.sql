-- SOF-66: tenant/admin/pending-only batch selector contract.
-- Run against a clean, ephemeral CI database. No real outbound messages.
BEGIN;
DO $$
DECLARE
  v_fn regprocedure;
  v_body text;
  v_legacy_fn regprocedure;
  v_legacy_body text;
  v_check jsonb;
BEGIN
  v_fn:=to_regprocedure(
    'public.update_pending_agent_task_targets(uuid,uuid,uuid,uuid,uuid[],integer,integer)'
  );
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'SOF66_BATCH_EDITOR_RPC_MISSING';
  END IF;
  IF has_function_privilege('anon',v_fn,'EXECUTE')
    OR has_function_privilege('authenticated',v_fn,'EXECUTE') THEN
    RAISE EXCEPTION 'SOF66_BATCH_EDITOR_CLIENT_GRANT_LEAK';
  END IF;
  IF NOT has_function_privilege('service_role',v_fn,'EXECUTE') THEN
    RAISE EXCEPTION 'SOF66_BATCH_EDITOR_SERVICE_ROLE_MISSING';
  END IF;
  v_body:=pg_get_functiondef(v_fn);
  IF position('account_id=p_account_id' in v_body)=0
    OR position('account_role::text IN (''owner'',''admin'')' in v_body)=0
    OR position('FOR UPDATE' in v_body)=0
    OR position('task_already_started' in v_body)=0
    OR position('v_count>20' in v_body)=0
    OR position('count(DISTINCT' in v_body)=0
    OR position('update_pending_agent_task_connection' in v_body)=0
    OR position('selectedContactIds' in v_body)=0 THEN
    RAISE EXCEPTION 'SOF66_BATCH_EDITOR_GUARD_MISSING';
  END IF;

  -- Guard against legacy scalar editor silently turning a precise batch into
  -- mixed/automatic targeting after the additive migration.
  v_legacy_fn:=to_regprocedure(
    'public.update_pending_agent_task_target(uuid,uuid,uuid,uuid,uuid,integer,integer)'
  );
  IF v_legacy_fn IS NULL THEN
    RAISE EXCEPTION 'SOF66_LEGACY_EDITOR_MISSING';
  END IF;
  v_legacy_body:=pg_get_functiondef(v_legacy_fn);
  IF position('multi_contact_requires_list_editor' in v_legacy_body)=0
    OR position('selected_contact_cannot_be_cleared' in v_legacy_body)=0 THEN
    RAISE EXCEPTION 'SOF66_LEGACY_EDITOR_SELECTION_GUARD_MISSING';
  END IF;

  -- No tenant or authenticated actor may edit anything, even with
  -- seemingly valid contact IDs.
  v_check:=public.update_pending_agent_task_targets(
    gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),null,
    ARRAY[gen_random_uuid(),gen_random_uuid()],2,1
  );
  IF v_check->>'reason'<>'admin_required' OR
    (v_check->>'updated')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'SOF66_BATCH_EDITOR_UNAUTHORIZED_CHANGE';
  END IF;
END $$;
ROLLBACK;
