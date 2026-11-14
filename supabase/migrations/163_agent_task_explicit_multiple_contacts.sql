-- SOF-66: one durable Coverage Task may target several exact, eligible CRM
-- contact IDs. Extends the existing pending-only editor; never widens sends,
-- tenant scope, permissions, connection routing or per-target admission.
-- The application checks each supplier's Coverage eligibility before RPC;
-- the authoritative resolver and SQL guardrails repeat domain/admission checks
-- for each target when the worker materializes/dispatches it.
CREATE FUNCTION public.update_pending_agent_task_targets(
  p_account_id uuid,
  p_task_id uuid,
  p_actor_user_id uuid,
  p_connection_id uuid,
  p_selected_contact_ids uuid[],
  p_max_targets integer,
  p_max_attempts_per_target integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog, public
AS $$
DECLARE
  v_task public.ai_agent_tasks%ROWTYPE;
  v_count integer;
  v_result jsonb;
  v_policy jsonb;
BEGIN
  IF p_actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.account_id=p_account_id AND p.user_id=p_actor_user_id
      AND p.account_role::text IN ('owner','admin')
  ) THEN
    RETURN jsonb_build_object('updated',false,'reason','admin_required');
  END IF;

  SELECT * INTO v_task FROM public.ai_agent_tasks
    WHERE account_id=p_account_id AND id=p_task_id
    FOR UPDATE;
  IF v_task.id IS NULL THEN
    RETURN jsonb_build_object('updated',false,'reason','task_not_found');
  END IF;
  IF v_task.task_type<>'coverage.sourcing' OR v_task.channel<>'whatsapp' THEN
    RETURN jsonb_build_object('updated',false,'reason','unsupported_task_type');
  END IF;
  IF v_task.status NOT IN ('queued','scheduled') THEN
    RETURN jsonb_build_object('updated',false,'reason','task_not_editable');
  END IF;
  -- The same lock is used by the existing connection update RPC.
  IF EXISTS (SELECT 1 FROM public.ai_agent_task_targets x
      WHERE x.account_id=p_account_id AND x.task_id=p_task_id)
    OR EXISTS (SELECT 1 FROM public.ai_agent_runs r
      WHERE r.account_id=p_account_id AND r.task_id=p_task_id)
    OR EXISTS (SELECT 1 FROM public.ai_agent_task_outbound_messages o
      WHERE o.account_id=p_account_id AND o.task_id=p_task_id) THEN
    RETURN jsonb_build_object('updated',false,'reason','task_already_started');
  END IF;

  v_count:=cardinality(p_selected_contact_ids);
  IF v_count IS NULL OR v_count<1 OR v_count>20
    OR p_max_targets IS DISTINCT FROM v_count
    OR p_max_attempts_per_target IS NULL OR p_max_attempts_per_target<1
    OR EXISTS(SELECT 1 FROM unnest(p_selected_contact_ids) AS x(id)
      WHERE x.id IS NULL)
    OR (SELECT count(DISTINCT x.id) FROM unnest(p_selected_contact_ids) AS x(id))<>v_count
  THEN
    RETURN jsonb_build_object('updated',false,'reason','selected_contacts_invalid');
  END IF;
  IF (SELECT count(*) FROM public.contacts c
      WHERE c.account_id=p_account_id AND c.id=ANY(p_selected_contact_ids))<>v_count THEN
    RETURN jsonb_build_object('updated',false,'reason','contact_not_found');
  END IF;

  -- This RPC never allows a pending Task's maximum authorized Targets or
  -- attempts to grow; create a NEW Task to increase an existing maximum.
  v_result:=public.update_pending_agent_task_connection(
    p_account_id,p_task_id,p_actor_user_id,p_connection_id,
    p_max_targets,p_max_attempts_per_target
  );
  IF coalesce((v_result->>'updated')::boolean,false) IS DISTINCT FROM true THEN
    RETURN v_result;
  END IF;

  SELECT target_policy INTO v_policy FROM public.ai_agent_tasks
    WHERE id=p_task_id AND account_id=p_account_id;
  v_policy:=coalesce(v_policy,'{}'::jsonb)
    - 'selectedContactId' - 'selectedContactIds';
  IF v_count=1 THEN
    v_policy:=jsonb_set(v_policy,'{selectedContactId}',
      to_jsonb(p_selected_contact_ids[1]::text),true);
  ELSE
    v_policy:=jsonb_set(v_policy,'{selectedContactIds}',
      to_jsonb(p_selected_contact_ids::text[]),true);
  END IF;
  UPDATE public.ai_agent_tasks
    SET target_policy=v_policy,updated_at=now()
    WHERE id=p_task_id AND account_id=p_account_id;

  PERFORM public.append_agent_task_event(
    p_account_id,p_task_id,null,null,
    'task.selected_contacts_updated','user',p_actor_user_id::text,
    jsonb_build_object(
      'count',v_count,
      'max_attempts_per_target',p_max_attempts_per_target
    )
  );
  RETURN v_result||jsonb_build_object('selected_contact_count',v_count);
END $$;

REVOKE ALL ON FUNCTION public.update_pending_agent_task_targets(
  uuid,uuid,uuid,uuid,uuid[],integer,integer
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.update_pending_agent_task_targets(
  uuid,uuid,uuid,uuid,uuid[],integer,integer
) TO service_role;

COMMENT ON FUNCTION public.update_pending_agent_task_targets(
  uuid,uuid,uuid,uuid,uuid[],integer,integer
) IS 'SOF-66: update exact selected CRM recipients only on pending eligible Coverage Tasks with no Targets/Runs/reservations. Tenant owner/admin, frozen caps, no client function grants.';
