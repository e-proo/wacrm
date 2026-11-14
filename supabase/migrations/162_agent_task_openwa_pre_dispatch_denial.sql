-- SOF-63: resolve a typed, unequivocal OpenWA pre-dispatch denial.
-- Never turn a transport timeout, unexpected exception, or ambiguous outcome
-- into failure: only the caller holding the sending claim and an explicit
-- OpenWAPreDispatchDenied exception may invoke this service-role-only RPC.
-- No resend, no resetting attempts, and no tampering with guardrail events.
CREATE OR REPLACE FUNCTION public.finalize_agent_task_outbound_pre_dispatch_denial(
  p_account_id uuid,
  p_reservation_id uuid,
  p_worker_id text,
  p_reason_code text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_outbound public.ai_agent_task_outbound_messages%ROWTYPE;
  v_run public.ai_agent_runs%ROWTYPE;
  v_task public.ai_agent_tasks%ROWTYPE;
  v_target public.ai_agent_task_targets%ROWTYPE;
BEGIN
  IF p_account_id IS NULL OR p_reservation_id IS NULL
     OR length(btrim(coalesce(p_worker_id,'')))=0
     OR p_reason_code IS NULL
     OR p_reason_code !~ '^[A-Z0-9_]{3,120}$' THEN
    RAISE EXCEPTION 'AGENT_PRE_DISPATCH_DENIAL_INPUT_INVALID';
  END IF;

  SELECT * INTO v_outbound
  FROM public.ai_agent_task_outbound_messages
  WHERE account_id=p_account_id AND id=p_reservation_id
    AND status='sending' AND claimed_by=p_worker_id
    AND provider='openwa' AND connection_id IS NOT NULL
    AND local_message_id IS NULL AND whatsapp_message_id IS NULL
  FOR UPDATE;
  IF v_outbound.id IS NULL THEN
    RETURN false;
  END IF;

  SELECT * INTO v_run FROM public.ai_agent_runs
    WHERE account_id=p_account_id AND id=v_outbound.run_id
      AND task_id=v_outbound.task_id
      AND task_target_id=v_outbound.task_target_id
      AND run_mode='outbound' AND status='claimed'
    FOR UPDATE;
  IF v_run.id IS NULL THEN RETURN false; END IF;

  SELECT * INTO v_task FROM public.ai_agent_tasks
    WHERE account_id=p_account_id AND id=v_outbound.task_id
      AND status='running'
    FOR UPDATE;
  IF v_task.id IS NULL THEN RETURN false; END IF;

  SELECT * INTO v_target FROM public.ai_agent_task_targets
    WHERE account_id=p_account_id AND task_id=v_outbound.task_id
      AND id=v_outbound.task_target_id AND status='in_progress'
      AND attempt_count>0
    FOR UPDATE;
  IF v_target.id IS NULL THEN RETURN false; END IF;

  -- The guardrail denied before OpenWA was called. Keep a terminal, unsent
  -- identity to prevent any later worker from resending this first attempt.
  UPDATE public.ai_agent_task_outbound_messages
     SET status='failed', claimed_by=null,lease_expires_at=null,
         error_code='OPENWA_PRE_DISPATCH_DENIED',
         error_detail=left(p_reason_code,120)
   WHERE id=v_outbound.id AND account_id=p_account_id;
  UPDATE public.ai_agent_runs
     SET status='failed',completed_at=now(),claimed_by=null,
         lease_expires_at=null,error_code='OPENWA_PRE_DISPATCH_DENIED'
   WHERE id=v_run.id AND account_id=p_account_id;
  UPDATE public.ai_agent_task_targets
     SET status='exhausted', completed_at=coalesce(completed_at,now()),
         next_action_at=null, available_at=now(),
         failure_code='OPENWA_PRE_DISPATCH_DENIED'
   WHERE id=v_target.id AND account_id=p_account_id AND task_id=v_task.id;

  PERFORM public.append_agent_task_event(
    p_account_id,v_task.id,v_target.id,v_run.id,
    'message.pre_dispatch_denied','service',p_worker_id,
    jsonb_build_object(
      'reservation_id',v_outbound.id,
      'reason_code',p_reason_code,
      'provider_dispatch_attempted',false,
      'retry_allowed',false
    )
  );
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.finalize_agent_task_outbound_pre_dispatch_denial(
  uuid,uuid,text,text
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_agent_task_outbound_pre_dispatch_denial(
  uuid,uuid,text,text
) TO service_role;

COMMENT ON FUNCTION public.finalize_agent_task_outbound_pre_dispatch_denial(
  uuid,uuid,text,text
) IS 'SOF-63: conclude a service-confirmed OpenWA pre-provider denial as failed/exhausted without reconciliation or retry; unknown outcomes remain unreconciled.';
