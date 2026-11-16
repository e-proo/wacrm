-- Durable WACRM-owned broadcast delivery queue.
-- Meta remains the official default provider; OpenWA remains optional transport only.
-- Service role is required for all job/lease mutations. Never grant a browser access.
ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS broadcast_header_media_url text;
ALTER TABLE public.broadcast_recipients
  ADD COLUMN IF NOT EXISTS dispatch_reserved_at timestamptz;

CREATE TABLE IF NOT EXISTS public.broadcast_delivery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  broadcast_id uuid NOT NULL UNIQUE REFERENCES public.broadcasts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.whatsapp_connections(id),
  provider text NOT NULL CHECK (provider IN ('meta_cloud','openwa')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','leased','paused','completed')),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  worker_id text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  paused_reason text,
  last_error text,
  last_processed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broadcast_jobs_lease_shape CHECK (
    (state = 'leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state <> 'leased' AND lease_token IS NULL AND lease_until IS NULL)
  )
);

ALTER TABLE public.broadcast_delivery_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.broadcast_delivery_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.broadcast_delivery_jobs TO service_role;
CREATE INDEX IF NOT EXISTS idx_broadcast_jobs_work
  ON public.broadcast_delivery_jobs(next_attempt_at,created_at)
  WHERE state IN ('queued','leased');
CREATE INDEX IF NOT EXISTS idx_broadcast_jobs_account
  ON public.broadcast_delivery_jobs(account_id,state,created_at);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_sending_reserved
  ON public.broadcast_recipients(broadcast_id,dispatch_reserved_at)
  WHERE status = 'sending';

COMMENT ON TABLE public.broadcast_delivery_jobs IS
  'Server-only durable delivery queue. A worker lease is NOT a recipient send claim; the recipient pending->sending CAS prevents duplicates.';
COMMENT ON COLUMN public.broadcast_recipients.dispatch_reserved_at IS
  'Reserved before provider attempt; an abandoned sending row requires reconciliation, not retry.';

/*
 * Enqueue and resume atomically. The calling server MUST authorize its user
 * separately. SQL repeats all tenant, completeness, pinned-connection and
 * reconciliation checks even though it runs with service role privileges.
 */
CREATE OR REPLACE FUNCTION public.enqueue_broadcast_delivery_job(
  p_account_id uuid,
  p_broadcast_id uuid,
  p_scope text DEFAULT 'pending',
  p_header_media_url text DEFAULT NULL
)
RETURNS TABLE(job_id uuid, job_state text, pending_count bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_broadcast public.broadcasts%ROWTYPE;
  v_total bigint;
  v_pending bigint;
  v_unsettled bigint;
  v_not_pinned bigint;
  v_distinct_connections bigint;
  v_provider text;
  v_connection_id uuid;
  v_connection_status text;
  v_connection_provider text;
  v_job public.broadcast_delivery_jobs%ROWTYPE;
  v_nonretryable bigint;
BEGIN
  IF p_scope NOT IN ('pending','failed') THEN
    RAISE EXCEPTION 'Unsupported broadcast resume scope' USING ERRCODE = '22023';
  END IF;
  IF p_header_media_url IS NOT NULL AND
     (length(p_header_media_url) > 2048 OR p_header_media_url !~ '^https://') THEN
    RAISE EXCEPTION 'Broadcast header media must be an HTTPS URL' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_broadcast FROM public.broadcasts
    WHERE id = p_broadcast_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account-scoped broadcast not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT count(*),
    count(*) FILTER (WHERE status='pending'),
    count(*) FILTER (WHERE status IN ('sending','requires_reconciliation')),
    count(*) FILTER (WHERE connection_id IS NULL OR provider IS NULL),
    count(DISTINCT (connection_id, provider))
    INTO v_total,v_pending,v_unsettled,v_not_pinned,v_distinct_connections
    FROM public.broadcast_recipients WHERE broadcast_id=p_broadcast_id;
  IF v_total=0 OR v_total IS DISTINCT FROM v_broadcast.total_recipients OR
     v_not_pinned > 0 OR v_distinct_connections <> 1 THEN
    RAISE EXCEPTION 'Broadcast has incomplete or mixed provider-bound recipients'
      USING ERRCODE = '23514';
  END IF;
  IF v_unsettled > 0 THEN
    RAISE EXCEPTION 'Broadcast has unsettled provider attempts; reconciliation required'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT provider,connection_id INTO v_provider,v_connection_id
    FROM public.broadcast_recipients WHERE broadcast_id=p_broadcast_id LIMIT 1;
  SELECT provider,status INTO v_connection_provider,v_connection_status
    FROM public.whatsapp_connections
    WHERE id=v_connection_id AND account_id=p_account_id AND archived_at IS NULL;
  IF NOT FOUND OR v_connection_provider IS DISTINCT FROM v_provider OR
     NOT ((v_provider='meta_cloud' AND v_connection_status='connected') OR
          (v_provider='openwa' AND v_connection_status IN ('ready','connected'))) THEN
    RAISE EXCEPTION 'Broadcast connection is not ready in this account'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_job FROM public.broadcast_delivery_jobs
    WHERE broadcast_id=p_broadcast_id AND account_id=p_account_id FOR UPDATE;
  IF FOUND AND v_job.state='leased' AND v_job.lease_until > now() THEN
    RAISE EXCEPTION 'Broadcast worker already owns an active lease'
      USING ERRCODE = '55P03';
  END IF;
  IF p_scope='failed' THEN
    SELECT count(*) INTO v_nonretryable FROM public.broadcast_recipients
      WHERE broadcast_id=p_broadcast_id AND status='failed'
        AND error_message IS DISTINCT FROM 'PRE_DISPATCH_DENIED';
    IF v_nonretryable>0 THEN
      RAISE EXCEPTION 'Legacy or unproven failed sends require manual reconciliation'
        USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.broadcast_recipients
      SET status='pending',error_message=NULL,dispatch_reserved_at=NULL
      WHERE broadcast_id=p_broadcast_id AND status='failed'
        AND error_message='PRE_DISPATCH_DENIED';
    GET DIAGNOSTICS v_pending=ROW_COUNT;
    IF v_pending=0 THEN
      RAISE EXCEPTION 'No verified pre-dispatch denial to retry'
        USING ERRCODE = '22023';
    END IF;
  END IF;
  SELECT count(*) INTO v_pending FROM public.broadcast_recipients
    WHERE broadcast_id=p_broadcast_id AND status='pending';
  IF v_pending=0 THEN
    RAISE EXCEPTION 'No pending recipients to enqueue' USING ERRCODE='22023';
  END IF;

  IF v_job.id IS NULL THEN
    INSERT INTO public.broadcast_delivery_jobs
      (account_id,broadcast_id,connection_id,provider,state)
    VALUES (p_account_id,p_broadcast_id,v_connection_id,v_provider,'queued')
    RETURNING * INTO v_job;
  ELSE
    IF v_job.connection_id<>v_connection_id OR v_job.provider<>v_provider THEN
      RAISE EXCEPTION 'Broadcast transport binding has changed'
        USING ERRCODE='23514';
    END IF;
    UPDATE public.broadcast_delivery_jobs SET
      state='queued',next_attempt_at=now(),lease_token=NULL,lease_until=NULL,
      worker_id=NULL,paused_reason=NULL,last_error=NULL,completed_at=NULL,updated_at=now()
      WHERE id=v_job.id RETURNING * INTO v_job;
  END IF;
  UPDATE public.broadcasts SET
    status='sending',
    broadcast_header_media_url=COALESCE(p_header_media_url,broadcast_header_media_url),
    updated_at=now()
    WHERE id=p_broadcast_id AND account_id=p_account_id;
  RETURN QUERY SELECT v_job.id,v_job.state,v_pending;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_broadcast_delivery_job(p_worker_id text)
RETURNS TABLE(
  job_id uuid,broadcast_id uuid,account_id uuid,
  connection_id uuid,provider text,lease_token uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_worker_id IS NULL OR length(btrim(p_worker_id))=0 OR length(p_worker_id)>120 THEN
    RAISE EXCEPTION 'Invalid worker identity' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT j.id FROM public.broadcast_delivery_jobs j
      JOIN public.broadcasts b ON b.id=j.broadcast_id AND b.account_id=j.account_id
      WHERE b.status='sending'
        AND j.next_attempt_at<=now()
        AND (j.state='queued' OR (j.state='leased' AND j.lease_until<now()))
      ORDER BY j.next_attempt_at ASC,j.created_at ASC
      FOR UPDATE OF j SKIP LOCKED LIMIT 1
  )
  UPDATE public.broadcast_delivery_jobs j SET
    state='leased',lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',
    worker_id=p_worker_id,attempt_count=j.attempt_count+1,updated_at=now()
    FROM candidate c WHERE j.id=c.id
    RETURNING j.id,j.broadcast_id,j.account_id,j.connection_id,j.provider,j.lease_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_broadcast_delivery_job(
  p_job_id uuid, p_lease_token uuid, p_state text,
  p_delay_seconds integer DEFAULT 0, p_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_found boolean;
BEGIN
  IF p_state NOT IN ('queued','paused','completed') OR
    p_delay_seconds<0 OR p_delay_seconds>3600 THEN
    RAISE EXCEPTION 'Invalid worker settlement' USING ERRCODE = '22023';
  END IF;
  UPDATE public.broadcast_delivery_jobs SET
    state=p_state,lease_token=NULL,lease_until=NULL,worker_id=NULL,
    next_attempt_at=now()+make_interval(secs=>p_delay_seconds),
    paused_reason=CASE WHEN p_state='paused' THEN left(p_reason,200) ELSE NULL END,
    last_error=CASE WHEN p_state='paused' THEN left(p_reason,200) ELSE NULL END,
    last_processed_at=now(),
    completed_at=CASE WHEN p_state='completed' THEN now() ELSE NULL END,
    updated_at=now()
  WHERE id=p_job_id AND lease_token=p_lease_token AND state='leased';
  GET DIAGNOSTICS v_found=ROW_COUNT;
  RETURN v_found;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_broadcast_delivery_job(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_broadcast_delivery_job(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_broadcast_delivery_job(uuid,uuid,text,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_broadcast_delivery_job(uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_broadcast_delivery_job(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_broadcast_delivery_job(uuid,uuid,text,integer,text) TO service_role;
