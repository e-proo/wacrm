-- Per-account TEST Task worker and safe manual closure schema/security.
-- Read-only assertions, no tasks, grants, transports or messages modified.
BEGIN;
DO $check$
DECLARE v_def text; v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM information_schema.columns
  WHERE table_schema='public' AND table_name='ai_agent_tasks'
    AND column_name IN ('manual_closure_kind','manual_closed_at','manual_closed_by','manual_closure_note');
  IF v_count<>4 THEN RAISE EXCEPTION 'Manual closure audit fields missing'; END IF;

  SELECT count(*) INTO v_count FROM information_schema.columns
  WHERE table_schema='public' AND table_name='ai_runtime_policies'
    AND column_name='task_worker_enabled' AND column_default='true';
  IF v_count<>1 THEN RAISE EXCEPTION 'Per-account Task worker default missing'; END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class
    WHERE oid='public.ai_agent_task_worker_control_events'::regclass) THEN
    RAISE EXCEPTION 'Task worker audit table RLS missing';
  END IF;
  IF has_table_privilege('anon','public.ai_agent_task_worker_control_events','SELECT')
    OR has_table_privilege('authenticated','public.ai_agent_task_worker_control_events','SELECT')
    OR has_table_privilege('anon','public.ai_agent_task_worker_control_events','INSERT')
    OR has_table_privilege('authenticated','public.ai_agent_task_worker_control_events','INSERT') THEN
    RAISE EXCEPTION 'Task worker audit access is not service-only';
  END IF;
  IF has_function_privilege('authenticated','public.admin_close_agent_task(uuid,uuid,uuid,text,text)','EXECUTE')
    OR has_function_privilege('anon','public.admin_close_agent_task(uuid,uuid,uuid,text,text)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.admin_close_agent_task(uuid,uuid,uuid,text,text)','EXECUTE')
    OR has_function_privilege('authenticated','public.set_agent_task_worker_enabled(uuid,uuid,boolean)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.set_agent_task_worker_enabled(uuid,uuid,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'Operator controls must be service-only';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.proname='claim_next_agent_task'
      AND p.pronamespace='public'::regnamespace;
  IF position('task_worker_enabled' IN coalesce(v_def,''))=0 THEN
    RAISE EXCEPTION 'Task queue claim does not honor paused account';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.proname='claim_next_agent_task_trigger_firing'
      AND p.pronamespace='public'::regnamespace;
  IF position('task_worker_enabled' IN coalesce(v_def,''))=0 THEN
    RAISE EXCEPTION 'Trigger claim ignores paused account';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.proname='materialize_agent_task_trigger_firings'
      AND p.pronamespace='public'::regnamespace;
  IF position('task_worker_enabled' IN coalesce(v_def,''))=0 THEN
    RAISE EXCEPTION 'Trigger materialization ignores paused account';
  END IF;

  -- No user supplied UUID can modify a task in an unknown tenant.
  IF (public.admin_close_agent_task(
        '00000000-0000-4000-8000-000000000001'::uuid,
        '00000000-0000-4000-8000-000000000002'::uuid,
        '00000000-0000-4000-8000-000000000003'::uuid,
        'cancel',NULL)->>'reason') IS DISTINCT FROM 'not_found' THEN
    RAISE EXCEPTION 'Manual closure scope must deny unknown task';
  END IF;
END $check$;
ROLLBACK;
