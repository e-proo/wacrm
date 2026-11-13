-- SOF-59 / Phase 18: durable, tenant-scoped WhatsApp transport binding.
-- Additive migration: existing Meta/Agent Task RPC signatures remain intact.
-- The new bound RPCs are service-role-only and are used by the outbound worker.
-- No provider dispatch occurs in SQL.
ALTER TABLE public.ai_agent_task_outbound_messages
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS connection_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_account_id_transport_uidx
  ON public.whatsapp_connections (account_id, id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.ai_agent_task_outbound_messages'::regclass
      AND conname='agent_task_outbound_connection_provider_check'
  ) THEN
    ALTER TABLE public.ai_agent_task_outbound_messages
      ADD CONSTRAINT agent_task_outbound_connection_provider_check
      CHECK (
        (provider IS NULL AND connection_id IS NULL)
        OR (provider IN ('meta_cloud','openwa') AND connection_id IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.ai_agent_task_outbound_messages'::regclass
      AND conname='agent_task_outbound_account_connection_fk'
  ) THEN
    ALTER TABLE public.ai_agent_task_outbound_messages
      ADD CONSTRAINT agent_task_outbound_account_connection_fk
      FOREIGN KEY (account_id, connection_id)
      REFERENCES public.whatsapp_connections(account_id,id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.protect_agent_task_outbound_connection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.connection_id IS NOT NULL AND (
      NEW.connection_id IS DISTINCT FROM OLD.connection_id
      OR NEW.provider IS DISTINCT FROM OLD.provider
  ) THEN
    RAISE EXCEPTION 'AGENT_TASK_TRANSPORT_BINDING_IMMUTABLE';
  END IF;
  IF OLD.connection_id IS NULL AND NEW.connection_id IS NOT NULL
     AND OLD.status <> 'reserved' THEN
    RAISE EXCEPTION 'AGENT_TASK_TRANSPORT_BINDING_LATE';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS protect_agent_task_outbound_connection
  ON public.ai_agent_task_outbound_messages;
CREATE TRIGGER protect_agent_task_outbound_connection
  BEFORE UPDATE OF provider, connection_id
  ON public.ai_agent_task_outbound_messages
  FOR EACH ROW EXECUTE FUNCTION public.protect_agent_task_outbound_connection();

-- Provider/session is chosen from the Task's frozen target_policy, or the
-- target conversation's latest inbound *when it has an explicit connection*.
-- Never infer Meta when the inbound has no connection and no Task choice.
CREATE OR REPLACE FUNCTION public.reserve_bound_agent_task_outbound_message(
  p_run_id uuid,
  p_policy_key text,
  p_policy_version integer,
  p_message_kind text,
  p_candidate_text text,
  p_template_name text,
  p_template_language text,
  p_template_params jsonb,
  p_max_followups integer,
  p_minimum_interval_minutes integer,
  p_maximum_interval_minutes integer,
  p_stop_on_reply boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_run public.ai_agent_runs%ROWTYPE;
  v_task public.ai_agent_tasks%ROWTYPE;
  v_target public.ai_agent_task_targets%ROWTYPE;
  v_connection public.whatsapp_connections%ROWTYPE;
  v_outbound public.ai_agent_task_outbound_messages%ROWTYPE;
  v_result jsonb;
  v_raw text;
  v_connection_id uuid;
BEGIN
  SELECT * INTO v_run FROM public.ai_agent_runs
    WHERE id=p_run_id FOR UPDATE;
  IF v_run.id IS NULL OR v_run.run_mode<>'outbound'
     OR v_run.status<>'claimed' OR v_run.task_id IS NULL
     OR v_run.task_target_id IS NULL THEN
    RETURN jsonb_build_object('reserved',false,'reason','run_not_outbound');
  END IF;

  SELECT * INTO v_task FROM public.ai_agent_tasks
    WHERE account_id=v_run.account_id AND id=v_run.task_id FOR UPDATE;
  SELECT * INTO v_target FROM public.ai_agent_task_targets
    WHERE account_id=v_run.account_id AND task_id=v_run.task_id
      AND id=v_run.task_target_id FOR UPDATE;
  IF v_task.id IS NULL OR v_target.id IS NULL
     OR v_target.conversation_id IS NULL OR v_target.contact_id IS NULL THEN
    RETURN jsonb_build_object('reserved',false,'reason','target_context_missing');
  END IF;

  IF v_task.target_policy ? 'whatsappConnectionId' THEN
    IF jsonb_typeof(v_task.target_policy->'whatsappConnectionId')<>'string' THEN
      RETURN jsonb_build_object('reserved',false,'reason','connection_selection_invalid');
    END IF;
    v_raw:=v_task.target_policy->>'whatsappConnectionId';
    BEGIN
      v_connection_id:=v_raw::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN jsonb_build_object('reserved',false,'reason','connection_selection_invalid');
    END;
  ELSE
    SELECT m.connection_id INTO v_connection_id FROM public.messages m
      WHERE m.conversation_id=v_target.conversation_id
        AND m.sender_type='customer'
      ORDER BY m.created_at DESC NULLS LAST, m.id DESC
      LIMIT 1;
  END IF;

  IF v_connection_id IS NULL THEN
    RETURN jsonb_build_object('reserved',false,'reason','connection_selection_required');
  END IF;

  SELECT * INTO v_connection FROM public.whatsapp_connections
    WHERE id=v_connection_id AND account_id=v_run.account_id FOR SHARE;
  IF v_connection.id IS NULL THEN
    RETURN jsonb_build_object('reserved',false,'reason','connection_not_found');
  END IF;
  IF v_connection.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('reserved',false,'reason','connection_archived');
  END IF;
  IF NOT (
    (v_connection.provider='meta_cloud' AND v_connection.status='connected')
    OR (v_connection.provider='openwa'
        AND v_connection.status IN ('ready','connected')
        AND v_connection.session_id IS NOT NULL)
  ) THEN
    RETURN jsonb_build_object('reserved',false,'reason','connection_not_ready');
  END IF;

  -- A Meta template cannot silently become an OpenWA text send.
  IF p_message_kind='template' AND v_connection.provider<>'meta_cloud' THEN
    RETURN jsonb_build_object('reserved',false,'reason','provider_template_unsupported');
  END IF;

  -- Session windows are connection-scoped. An inbound on Meta (or a different
  -- OpenWA session) must never authorize text from the selected connection.
  IF p_message_kind='text' AND NOT EXISTS (
    SELECT 1 FROM public.messages m
    WHERE m.conversation_id=v_target.conversation_id
      AND m.sender_type='customer'
      AND m.connection_id=v_connection.id
      AND m.created_at>=now()-interval '24 hours'
  ) THEN
    RETURN jsonb_build_object('reserved',false,'reason','connection_session_window_closed');
  END IF;

  v_result:=public.reserve_agent_task_outbound_message(
    p_run_id,p_policy_key,p_policy_version,p_message_kind,p_candidate_text,
    p_template_name,p_template_language,p_template_params,p_max_followups,
    p_minimum_interval_minutes,p_maximum_interval_minutes,p_stop_on_reply
  );
  IF coalesce((v_result->>'reserved')::boolean,false)<>true THEN
    RETURN v_result;
  END IF;

  SELECT * INTO v_outbound FROM public.ai_agent_task_outbound_messages
    WHERE id=(v_result->>'reservation_id')::uuid
      AND account_id=v_run.account_id FOR UPDATE;
  IF v_outbound.id IS NULL OR v_outbound.run_id<>p_run_id THEN
    RETURN jsonb_build_object('reserved',false,'reason','reservation_run_mismatch');
  END IF;
  IF v_outbound.connection_id IS NULL THEN
    IF v_outbound.status<>'reserved' THEN
      RETURN jsonb_build_object('reserved',false,'reason','unbound_prior_outcome');
    END IF;
    UPDATE public.ai_agent_task_outbound_messages
      SET provider=v_connection.provider, connection_id=v_connection.id
      WHERE id=v_outbound.id AND account_id=v_run.account_id
      RETURNING * INTO v_outbound;
  END IF;
  IF v_outbound.connection_id IS DISTINCT FROM v_connection.id
     OR v_outbound.provider IS DISTINCT FROM v_connection.provider THEN
    RETURN jsonb_build_object('reserved',false,'reason','reservation_transport_mismatch');
  END IF;
  RETURN v_result || jsonb_build_object(
    'provider',v_connection.provider,'connection_id',v_connection.id
  );
END $$;

REVOKE ALL ON FUNCTION public.reserve_bound_agent_task_outbound_message(
  uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_bound_agent_task_outbound_message(
  uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean
) TO service_role;

-- This wrapper preserves all original claim checks (suppression, template
-- approval, run/target state). It adds readiness/identity/window checks before
-- ownership is acquired and before any WhatsApp transport can be invoked.
CREATE OR REPLACE FUNCTION public.claim_bound_agent_task_outbound_message(
  p_reservation_id uuid,
  p_worker_id text,
  p_lease_secs integer DEFAULT 120
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_outbound public.ai_agent_task_outbound_messages%ROWTYPE;
  v_target public.ai_agent_task_targets%ROWTYPE;
  v_connection public.whatsapp_connections%ROWTYPE;
BEGIN
  SELECT * INTO v_outbound FROM public.ai_agent_task_outbound_messages
    WHERE id=p_reservation_id FOR UPDATE;
  IF v_outbound.id IS NULL THEN
    RETURN jsonb_build_object('claimed',false,'reason','not_found');
  END IF;
  IF v_outbound.status<>'reserved' THEN
    RETURN public.claim_agent_task_outbound_message(
      p_reservation_id,p_worker_id,p_lease_secs
    );
  END IF;
  IF v_outbound.connection_id IS NULL OR v_outbound.provider IS NULL THEN
    RETURN jsonb_build_object('claimed',false,'reason','connection_unbound');
  END IF;
  SELECT * INTO v_connection FROM public.whatsapp_connections
    WHERE account_id=v_outbound.account_id
      AND id=v_outbound.connection_id FOR SHARE;
  IF v_connection.id IS NULL
     OR v_connection.provider IS DISTINCT FROM v_outbound.provider THEN
    RETURN jsonb_build_object('claimed',false,'reason','connection_mismatch');
  END IF;
  IF v_connection.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed',false,'reason','connection_archived');
  END IF;
  IF NOT (
    (v_connection.provider='meta_cloud' AND v_connection.status='connected')
    OR (v_connection.provider='openwa'
        AND v_connection.status IN ('ready','connected')
        AND v_connection.session_id IS NOT NULL)
  ) THEN
    RETURN jsonb_build_object('claimed',false,'reason','connection_not_ready');
  END IF;
  IF v_outbound.message_kind='template' AND v_connection.provider<>'meta_cloud' THEN
    RETURN jsonb_build_object('claimed',false,'reason','provider_template_unsupported');
  END IF;
  IF v_outbound.message_kind='text' THEN
    SELECT * INTO v_target FROM public.ai_agent_task_targets
      WHERE id=v_outbound.task_target_id
        AND account_id=v_outbound.account_id
        AND task_id=v_outbound.task_id;
    IF v_target.conversation_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.conversation_id=v_target.conversation_id
        AND m.sender_type='customer'
        AND m.connection_id=v_outbound.connection_id
        AND m.created_at>=now()-interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('claimed',false,'reason','connection_session_window_closed');
    END IF;
  END IF;
  RETURN public.claim_agent_task_outbound_message(
    p_reservation_id,p_worker_id,p_lease_secs
  );
END $$;

REVOKE ALL ON FUNCTION public.claim_bound_agent_task_outbound_message(
  uuid,text,integer
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_bound_agent_task_outbound_message(
  uuid,text,integer
) TO service_role;

REVOKE ALL ON FUNCTION public.protect_agent_task_outbound_connection()
  FROM PUBLIC,anon,authenticated;

COMMENT ON COLUMN public.ai_agent_task_outbound_messages.connection_id IS
  'SOF-59 frozen account-scoped provider connection. Cannot be swapped after binding.';
COMMENT ON COLUMN public.ai_agent_task_outbound_messages.provider IS
  'SOF-59 frozen WhatsApp provider; server-derived, never chosen by an agent.';
