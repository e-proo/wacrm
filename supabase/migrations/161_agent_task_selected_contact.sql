-- SOF-65: update a pending Agent Task's exact selected CRM contact.
-- Uses the existing SOF-64 connection/limits RPC as the serialized
-- account/admin/started-state authority. No live sends or broader grants.
CREATE OR REPLACE FUNCTION public.update_pending_agent_task_target(
  p_account_id uuid,
  p_task_id uuid,
  p_actor_user_id uuid,
  p_connection_id uuid,
  p_selected_contact_id uuid,
  p_max_targets integer,
  p_max_attempts_per_target integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_task public.ai_agent_tasks%ROWTYPE;
  v_connection public.whatsapp_connections%ROWTYPE;
  v_result jsonb;
  v_policy jsonb;
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
  IF v_task.status NOT IN ('queued','scheduled') THEN
    RETURN jsonb_build_object('updated',false,'reason','task_not_editable');
  END IF;
  IF v_task.task_type<>'coverage.sourcing' THEN
    RETURN jsonb_build_object('updated',false,'reason','unsupported_task_type');
  END IF;
  IF p_selected_contact_id IS NOT NULL THEN
    IF p_max_targets<>1 OR p_max_targets IS NULL THEN
      RETURN jsonb_build_object('updated',false,'reason','single_contact_requires_one_target');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.contacts c WHERE c.account_id=p_account_id
        AND c.id=p_selected_contact_id
    ) THEN
      RETURN jsonb_build_object('updated',false,'reason','contact_not_found');
    END IF;
  END IF;
  IF p_connection_id IS NOT NULL THEN
    SELECT * INTO v_connection FROM public.whatsapp_connections
      WHERE account_id=p_account_id AND id=p_connection_id FOR SHARE;
    IF v_connection.provider='openwa' AND p_selected_contact_id IS NULL THEN
      RETURN jsonb_build_object('updated',false,'reason','selected_contact_required');
    END IF;
  END IF;
  v_result:=public.update_pending_agent_task_connection(
    p_account_id,p_task_id,p_actor_user_id,p_connection_id,
    p_max_targets,p_max_attempts_per_target
  );
  IF coalesce((v_result->>'updated')::boolean,false)<>true THEN
    RETURN v_result;
  END IF;

  SELECT target_policy INTO v_policy FROM public.ai_agent_tasks
    WHERE id=p_task_id AND account_id=p_account_id;
  IF p_selected_contact_id IS NULL THEN
    v_policy:=coalesce(v_policy,'{}'::jsonb)-'selectedContactId';
  ELSE
    v_policy:=jsonb_set(coalesce(v_policy,'{}'::jsonb),
      '{selectedContactId}',to_jsonb(p_selected_contact_id::text),true);
  END IF;
  UPDATE public.ai_agent_tasks
    SET target_policy=v_policy,updated_at=now()
    WHERE account_id=p_account_id AND id=p_task_id;

  RETURN v_result||jsonb_build_object(
    'selected_contact_id',p_selected_contact_id
  );
END $$;

REVOKE ALL ON FUNCTION public.update_pending_agent_task_target(
  uuid,uuid,uuid,uuid,uuid,integer,integer
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.update_pending_agent_task_target(
  uuid,uuid,uuid,uuid,uuid,integer,integer
) TO service_role;

COMMENT ON FUNCTION public.update_pending_agent_task_target(
  uuid,uuid,uuid,uuid,uuid,integer,integer
) IS 'SOF-65: guard a single selected CRM contact on a queued/scheduled WhatsApp Coverage Task; never mutate started Tasks or frozen reservations.';
