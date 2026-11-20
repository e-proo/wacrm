-- OW14-W05: terminal administrative disposition for unmatched native ACKs.
-- IMPORTANT: this closes retry work, NOT provider delivery status. No WhatsApp send.
-- Additive; never rewrite migration 179 or the status lifecycle.

ALTER TABLE public.openwa_deferred_events
  DROP CONSTRAINT openwa_deferred_events_state_check;
ALTER TABLE public.openwa_deferred_events
  ADD CONSTRAINT openwa_deferred_events_state_check
  CHECK (state IN ('pending','leased','completed','review',
                  'closed_unverified','closed_archive_observed'));

ALTER TABLE public.openwa_deferred_events
  ADD COLUMN disposition_at timestamptz,
  ADD COLUMN disposition_actor_id uuid,
  ADD COLUMN disposition_source text,
  ADD COLUMN disposition_code text,
  ADD COLUMN disposition_gateway_status text,
  ADD CONSTRAINT openwa_ack_disposition_shape CHECK (
    (state NOT IN ('closed_unverified','closed_archive_observed')
      AND disposition_at IS NULL AND disposition_actor_id IS NULL
      AND disposition_source IS NULL AND disposition_code IS NULL
      AND disposition_gateway_status IS NULL)
    OR
    (event_kind='unmatched_status'
      AND state IN ('closed_unverified','closed_archive_observed')
      AND disposition_at IS NOT NULL
      AND disposition_source IN ('admin_review','owner_requested_test')
      AND (disposition_actor_id IS NOT NULL OR disposition_source='owner_requested_test')
      AND (
        (state='closed_unverified' AND disposition_code='no_verified_evidence'
          AND disposition_gateway_status IS NULL)
        OR (state='closed_archive_observed' AND disposition_code='gateway_archive_observed'
          AND disposition_gateway_status IN ('pending','sent','delivered','read','failed'))
      )
    )
  );

CREATE INDEX openwa_deferred_disposition_idx
  ON public.openwa_deferred_events(account_id,connection_id,disposition_at DESC)
  WHERE state IN ('closed_unverified','closed_archive_observed');

-- Retain an append-only minimal audit even after the recovery ledger is pruned.
-- Deliberately store no native message ID, phone/JID, chat, body or credentials.
CREATE TABLE public.openwa_ack_disposition_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deferred_event_id uuid NOT NULL UNIQUE,
  account_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  actor_user_id uuid,
  source text NOT NULL CHECK (source IN ('admin_review','owner_requested_test')),
  finding text NOT NULL CHECK (finding IN ('no_verified_evidence','gateway_archive_observed')),
  gateway_status text CHECK (gateway_status IS NULL OR
    gateway_status IN ('pending','sent','delivered','read','failed')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT openwa_ack_audit_proof CHECK (
    (finding='no_verified_evidence' AND gateway_status IS NULL)
    OR (finding='gateway_archive_observed' AND gateway_status IS NOT NULL)
  )
);
CREATE INDEX openwa_ack_disposition_audit_scope_idx
  ON public.openwa_ack_disposition_audit(account_id,connection_id,recorded_at DESC);
ALTER TABLE public.openwa_ack_disposition_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.openwa_ack_disposition_audit FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.openwa_ack_disposition_audit TO service_role;
CREATE POLICY openwa_ack_disposition_service_only
  ON public.openwa_ack_disposition_audit FOR ALL TO service_role
  USING (true) WITH CHECK (true);
COMMENT ON TABLE public.openwa_ack_disposition_audit IS
  'Append-only, PII-minimal operator disposition. Unverified closure is not a delivery failure, successful delivery or resend authorization.';

CREATE FUNCTION public.close_openwa_unmatched_ack(
  p_account_id uuid, p_connection_id uuid, p_job_id uuid,
  p_actor uuid, p_finding text, p_gateway_status text, p_confirm_no_resend boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE
  v_job public.openwa_deferred_events%ROWTYPE;
  v_exists boolean;
  v_state text;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_account_id IS NULL OR p_connection_id IS NULL OR p_job_id IS NULL
     OR p_actor IS NULL OR p_confirm_no_resend IS DISTINCT FROM true
     OR p_finding IS NULL OR p_finding NOT IN ('no_verified_evidence','gateway_archive_observed')
     OR (p_finding='no_verified_evidence' AND p_gateway_status IS NOT NULL)
     OR (p_finding='gateway_archive_observed' AND
         (p_gateway_status IS NULL OR
          p_gateway_status NOT IN ('pending','sent','delivered','read','failed')))
  THEN RETURN pg_catalog.jsonb_build_object('updated',false,'reason','invalid_request'); END IF;

  -- SECURITY INVOKER, service_role-only EXECUTE, AND actor membership guard.
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.account_id=p_account_id
      AND p.user_id=p_actor AND p.account_role::text IN ('owner','admin')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('updated',false,'reason','actor_forbidden');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.whatsapp_connections c
    WHERE c.id=p_connection_id AND c.account_id=p_account_id
      AND c.provider='openwa' AND c.archived_at IS NULL
  ) INTO v_exists;
  IF NOT v_exists THEN
    RETURN pg_catalog.jsonb_build_object('updated',false,'reason','connection_scope_mismatch');
  END IF;

  SELECT q.* INTO v_job FROM public.openwa_deferred_events q
  WHERE q.id=p_job_id AND q.account_id=p_account_id
    AND q.connection_id=p_connection_id
    AND q.event_kind='unmatched_status'
    AND q.state IN ('pending','review')
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('updated',false,'reason','not_eligible_or_already_closed');
  END IF;

  -- A newly persisted local message must be reconciled by the normal,
  -- monotonic ACK worker rather than administratively buried.
  IF EXISTS (
    SELECT 1 FROM public.messages m
    WHERE m.connection_id=p_connection_id AND m.provider='openwa'
      AND m.provider_message_id=v_job.provider_message_id
  ) OR EXISTS (
    SELECT 1 FROM public.broadcast_recipients r
    WHERE r.connection_id=p_connection_id AND r.provider='openwa'
      AND r.provider_message_id=v_job.provider_message_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('updated',false,'reason','local_match_requires_reconciliation');
  END IF;

  v_state := CASE WHEN p_finding='gateway_archive_observed'
    THEN 'closed_archive_observed' ELSE 'closed_unverified' END;

  UPDATE public.openwa_deferred_events q
    SET state=v_state,
        lease_token=NULL,lease_until=NULL,
        disposition_at=v_now,disposition_actor_id=p_actor,
        disposition_source='admin_review',disposition_code=p_finding,
        disposition_gateway_status=p_gateway_status,
        updated_at=v_now,
        last_error_code=CASE WHEN p_finding='gateway_archive_observed'
          THEN 'operator_archive_observed' ELSE 'operator_closed_unverified' END
    WHERE q.id=v_job.id AND q.state IN ('pending','review');

  INSERT INTO public.openwa_ack_disposition_audit
    (deferred_event_id,account_id,connection_id,actor_user_id,source,
     finding,gateway_status,recorded_at)
  VALUES (v_job.id,p_account_id,p_connection_id,p_actor,'admin_review',
    p_finding,p_gateway_status,v_now);

  RETURN pg_catalog.jsonb_build_object('updated',true,'disposition',v_state,
    'delivery_confirmed',false,'outbound_resent',false);
END
$fn$;

REVOKE ALL ON FUNCTION public.close_openwa_unmatched_ack(uuid,uuid,uuid,uuid,text,text,boolean)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.close_openwa_unmatched_ack(uuid,uuid,uuid,uuid,text,text,boolean)
  TO service_role;

-- Keep explicit, finite PII retention. Minimal audit survives pruning.
CREATE OR REPLACE FUNCTION public.prune_openwa_deferred_events(p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE v_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN
    RAISE EXCEPTION 'Invalid OpenWA deferred prune limit' USING ERRCODE='22023';
  END IF;
  WITH expired AS (
    SELECT id FROM public.openwa_deferred_events
    WHERE (state='completed' AND completed_at<now()-interval '30 days')
       OR (state='review' AND updated_at<now()-interval '90 days')
       OR (state IN ('closed_unverified','closed_archive_observed')
           AND disposition_at<now()-interval '180 days')
    ORDER BY updated_at ASC LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.openwa_deferred_events j
    USING expired e WHERE j.id=e.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END
$fn$;
