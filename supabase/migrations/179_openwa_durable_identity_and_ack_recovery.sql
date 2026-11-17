-- OW-12/13 TEST: durable, server-owned recovery for signed OpenWA LID identity
-- and provider-native delivery receipts. Applied migrations are immutable.
-- The webhook intake and this deferred ledger share ONE atomic DB transaction
-- before the gateway receives 202. This queue never sends WhatsApp messages.

CREATE TABLE public.openwa_deferred_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 160),
  provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 255),
  provider_message_id text NOT NULL CHECK (length(provider_message_id) BETWEEN 1 AND 500),
  event_kind text NOT NULL CHECK (event_kind IN ('unresolved_identity','unmatched_status')),
  native_chat_id text,
  normalized_payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','completed','review')),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100000),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z_]{1,64}$'),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT openwa_deferred_event_identity UNIQUE (connection_id,provider_event_id),
  CONSTRAINT openwa_deferred_payload_shape CHECK (
    jsonb_typeof(normalized_payload)='object'
    AND octet_length(normalized_payload::text)<=65536
  ),
  CONSTRAINT openwa_deferred_identity_kind CHECK (
    (event_kind='unresolved_identity'
      AND native_chat_id ~ '^[0-9]{5,20}@lid$')
    OR (event_kind='unmatched_status' AND native_chat_id IS NULL)
  ),
  CONSTRAINT openwa_deferred_lease_shape CHECK (
    (state='leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state<>'leased' AND lease_token IS NULL AND lease_until IS NULL)
  )
);
CREATE INDEX openwa_deferred_due_idx ON public.openwa_deferred_events
  (next_attempt_at,created_at) WHERE state IN ('pending','leased');
CREATE INDEX openwa_deferred_account_idx ON public.openwa_deferred_events
  (account_id,connection_id,state,created_at DESC);

ALTER TABLE public.openwa_deferred_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.openwa_deferred_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.openwa_deferred_events TO service_role;
COMMENT ON TABLE public.openwa_deferred_events IS
  'Server-only queue for unresolved signed inbound identity and unmatched provider ACKs. No raw webhook, HMAC, credentials or inline media. Never dispatches WhatsApp outbound.';

-- An event is completed at intake ONLY after its compact, validated recovery
-- record is written in the same transaction. This is the critical crash barrier.
CREATE FUNCTION public.defer_openwa_webhook_event(
  p_account_id uuid,
  p_connection_id uuid,
  p_session_id text,
  p_event_id text,
  p_provider_message_id text,
  p_event_kind text,
  p_native_chat_id text,
  p_payload jsonb,
  p_processing_token uuid
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_row public.openwa_deferred_events%ROWTYPE;
BEGIN
  IF p_account_id IS NULL OR p_connection_id IS NULL OR p_processing_token IS NULL
     OR p_session_id IS NULL OR length(p_session_id) NOT BETWEEN 1 AND 160
     OR p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
     OR p_provider_message_id IS NULL OR length(p_provider_message_id) NOT BETWEEN 1 AND 500
     OR p_event_kind NOT IN ('unresolved_identity','unmatched_status')
     OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
     OR octet_length(p_payload::text)>65536 THEN
    RAISE EXCEPTION 'Invalid deferred event' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_connections c
    WHERE c.id=p_connection_id AND c.account_id=p_account_id
      AND c.provider='openwa' AND c.session_id=p_session_id AND c.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'OpenWA connection/session mismatch' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_webhook_event_receipts r
    WHERE r.account_id=p_account_id AND r.connection_id=p_connection_id
      AND r.provider='openwa' AND r.provider_event_id=p_event_id
      AND r.processing_token=p_processing_token AND r.processed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Signed webhook lease missing' USING ERRCODE='55P03';
  END IF;
  INSERT INTO public.openwa_deferred_events (
    account_id,connection_id,session_id,provider_event_id,
    provider_message_id,event_kind,native_chat_id,normalized_payload
  ) VALUES (
    p_account_id,p_connection_id,p_session_id,p_event_id,
    p_provider_message_id,p_event_kind,p_native_chat_id,p_payload
  ) ON CONFLICT (connection_id,provider_event_id) DO NOTHING;
  SELECT * INTO v_row FROM public.openwa_deferred_events
    WHERE connection_id=p_connection_id AND provider_event_id=p_event_id;
  IF NOT FOUND OR v_row.account_id<>p_account_id OR v_row.session_id<>p_session_id
    OR v_row.provider_message_id<>p_provider_message_id OR v_row.event_kind<>p_event_kind
    OR v_row.native_chat_id IS DISTINCT FROM p_native_chat_id
    OR v_row.normalized_payload<>p_payload THEN
    RAISE EXCEPTION 'Deferred event identity conflict' USING ERRCODE='23514';
  END IF;
  UPDATE public.whatsapp_webhook_event_receipts
    SET processed_at=now(),processing_started_at=NULL,
        processing_token=NULL,processing_error=NULL
    WHERE account_id=p_account_id AND connection_id=p_connection_id
      AND provider='openwa' AND provider_event_id=p_event_id
      AND processing_token=p_processing_token AND processed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not finalize signed webhook lease'
      USING ERRCODE='55P03';
  END IF;
  RETURN true;
END;
$$;

-- A bounded SKIP LOCKED claim prevents two worker processes from handling
-- the same deferred event concurrently. Expired leases are claimable again.
CREATE FUNCTION public.claim_openwa_deferred_events(p_limit integer DEFAULT 5)
RETURNS TABLE (
  job_id uuid,
  account_id uuid,
  connection_id uuid,
  session_id text,
  event_kind text,
  provider_message_id text,
  native_chat_id text,
  normalized_payload jsonb,
  attempt_count integer,
  lease_token uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>10 THEN
    RAISE EXCEPTION 'Invalid deferred worker batch' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT q.id FROM public.openwa_deferred_events q
    WHERE (q.state='pending' AND q.next_attempt_at<=now())
       OR (q.state='leased' AND q.lease_until<now())
    ORDER BY q.next_attempt_at,q.created_at
    FOR UPDATE OF q SKIP LOCKED LIMIT p_limit
  )
  UPDATE public.openwa_deferred_events q
    SET state='leased',lease_token=gen_random_uuid(),
        lease_until=now()+interval '3 minutes',
        attempt_count=q.attempt_count+1,updated_at=now()
    FROM picked p WHERE q.id=p.id
  RETURNING q.id,q.account_id,q.connection_id,q.session_id,
    q.event_kind,q.provider_message_id,q.native_chat_id,
    q.normalized_payload,q.attempt_count,q.lease_token;
END;
$$;

CREATE FUNCTION public.finish_openwa_deferred_event(
  p_job_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_delay_seconds integer DEFAULT 0,
  p_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_changed integer;
BEGIN
  IF p_outcome NOT IN ('completed','pending','review')
    OR p_delay_seconds IS NULL OR p_delay_seconds NOT BETWEEN 0 AND 86400
    OR (p_reason IS NOT NULL AND p_reason !~ '^[a-z_]{1,64}$') THEN
    RAISE EXCEPTION 'Invalid deferred settlement' USING ERRCODE='22023';
  END IF;
  UPDATE public.openwa_deferred_events q SET
    state=CASE WHEN p_outcome='pending' AND
      (q.attempt_count>=30 OR q.expires_at<now()) THEN 'review'
      ELSE p_outcome END,
    next_attempt_at=now()+make_interval(secs=>p_delay_seconds),
    lease_token=NULL,lease_until=NULL,updated_at=now(),
    last_error_code=p_reason,
    completed_at=CASE WHEN p_outcome='completed' THEN now() ELSE NULL END
  WHERE q.id=p_job_id AND q.lease_token=p_lease_token AND q.state='leased';
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  RETURN v_changed=1;
END;
$$;

-- Explicitly guard the SECURITY DEFINER API surface. No browser execution.
REVOKE ALL ON FUNCTION public.defer_openwa_webhook_event(uuid,uuid,text,text,text,text,text,jsonb,uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_openwa_deferred_events(integer)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_openwa_deferred_event(uuid,uuid,text,integer,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.defer_openwa_webhook_event(uuid,uuid,text,text,text,text,text,jsonb,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_openwa_deferred_events(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_openwa_deferred_event(uuid,uuid,text,integer,text)
  TO service_role;
