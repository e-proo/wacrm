-- SOF-64: safe, account-scoped updates to a Task's future WhatsApp route.
-- A Task can change route ONLY while queued/scheduled with no Target, Run
-- or outbound reservation. Never mutate an in-flight or ambiguous send.
CREATE OR REPLACE FUNCTION public.update_pending_agent_task_connection(
  p_account_id uuid,
  p_task_id uuid,
  p_actor_user_id uuid,
  p_connection_id uuid,
  p_max_targets integer DEFAULT NULL,
  p_max_attempts_per_target integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_task public.ai_agent_tasks%ROWTYPE;
  v_connection public.whatsapp_connections%ROWTYPE;
  v_policy jsonb;
  v_targets integer;
  v_attempts integer;
BEGIN
  IF p_actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id=p_actor_user_id AND p.account_id=p_account_id
      AND p.account_role::text IN ('owner','admin')
  ) THEN
    RETURN jsonb_build_object('updated',false,'reason','admin_required');
  END IF;
  SELECT * INTO v_task FROM public.ai_agent_tasks
    WHERE account_id=p_account_id AND id=p_task_id FOR UPDATE;
  IF v_task.id IS NULL THEN
    RETURN jsonb_build_object('updated',false,'reason','task_not_found');
  END IF;
  IF v_task.status NOT IN ('queued','scheduled')
      OR v_task.channel<>'whatsapp' THEN
    RETURN jsonb_build_object('updated',false,'reason','task_not_editable');
  END IF;
  IF EXISTS (SELECT 1 FROM public.ai_agent_task_targets
             WHERE account_id=p_account_id AND task_id=v_task.id)
      OR EXISTS (SELECT 1 FROM public.ai_agent_runs
                 WHERE account_id=p_account_id AND task_id=v_task.id)
      OR EXISTS (SELECT 1 FROM public.ai_agent_task_outbound_messages
                 WHERE account_id=p_account_id AND task_id=v_task.id) THEN
    RETURN jsonb_build_object('updated',false,'reason','task_already_started');
  END IF;

  v_targets:=coalesce(p_max_targets,v_task.max_targets);
  v_attempts:=coalesce(p_max_attempts_per_target,v_task.max_attempts_per_target);
  -- No limits can be enlarged after Task creation. The original upper
  -- bounds are those authorized by the published Builder revision.
  IF v_targets<1 OR v_targets>v_task.max_targets
     OR v_attempts<1 OR v_attempts>v_task.max_attempts_per_target THEN
    RETURN jsonb_build_object('updated',false,'reason','caps_cannot_increase');
  END IF;

  IF p_connection_id IS NOT NULL THEN
    SELECT * INTO v_connection FROM public.whatsapp_connections
      WHERE account_id=p_account_id AND id=p_connection_id FOR SHARE;
    IF v_connection.id IS NULL THEN
      RETURN jsonb_build_object('updated',false,'reason','connection_not_found');
    END IF;
    IF v_connection.archived_at IS NOT NULL THEN
      RETURN jsonb_build_object('updated',false,'reason','connection_archived');
    END IF;
    IF NOT (
       (v_connection.provider='meta_cloud' AND v_connection.status='connected')
       OR (v_connection.provider='openwa'
           AND v_connection.status IN ('ready','connected')
           AND v_connection.session_id IS NOT NULL)
    ) THEN
      RETURN jsonb_build_object('updated',false,'reason','connection_not_ready');
    END IF;
    IF v_task.task_type='coverage.sourcing'
       AND v_task.task_type_version<2
       AND v_connection.provider='openwa' THEN
      RETURN jsonb_build_object('updated',false,'reason','coverage_v2_required');
    END IF;
    v_policy:=jsonb_set(v_task.target_policy,'{whatsappConnectionId}',
      to_jsonb(p_connection_id::text),true);
  ELSE
    -- Explicitly return to the conversation's latest inbound route.
    -- The SOF-59 resolver rejects a missing inbound; it never guesses Meta.
    v_policy:=v_task.target_policy-'whatsappConnectionId';
  END IF;

  UPDATE public.ai_agent_tasks
    SET target_policy=v_policy,
        max_targets=v_targets,
        max_attempts_per_target=v_attempts,
        updated_at=now()
    WHERE account_id=p_account_id AND id=v_task.id;
  PERFORM public.append_agent_task_event(
    p_account_id,v_task.id,null,null,
    'task.connection_updated','user',p_actor_user_id::text,
    jsonb_build_object('connection_id',p_connection_id,
      'max_targets',v_targets,'max_attempts_per_target',v_attempts)
  );
  RETURN jsonb_build_object(
    'updated',true,'task_id',v_task.id,'connection_id',p_connection_id,
    'max_targets',v_targets,'max_attempts_per_target',v_attempts);
END $$;

REVOKE ALL ON FUNCTION public.update_pending_agent_task_connection(
  uuid,uuid,uuid,uuid,integer,integer
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.update_pending_agent_task_connection(
  uuid,uuid,uuid,uuid,integer,integer
) TO service_role;

COMMENT ON FUNCTION public.update_pending_agent_task_connection(
  uuid,uuid,uuid,uuid,integer,integer
) IS 'SOF-64: admin-authorized via API; pending Task only, no target/run/send and no cap increases.';
