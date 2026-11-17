-- Follow-up to applied 179: auditable, provider-verified manual LID mapping
-- plus bounded retention for the server-only recovery ledger.
ALTER TABLE public.openwa_deferred_events
  ADD COLUMN verified_phone text,
  ADD COLUMN verification_source text,
  ADD COLUMN verified_at timestamptz;
ALTER TABLE public.openwa_deferred_events
  ADD CONSTRAINT openwa_deferred_verified_phone_proof CHECK (
    (verified_phone IS NULL AND verification_source IS NULL AND verified_at IS NULL)
    OR (
      event_kind='unresolved_identity'
      AND verified_phone ~ '^[1-9][0-9]{6,14}$'
      AND verification_source='openwa_reverse_lid'
      AND verified_at IS NOT NULL
    )
  );

COMMENT ON COLUMN public.openwa_deferred_events.verified_phone IS
  'Provider-verified real phone, never guessed from an @lid. Admin-only reverse OpenWA LID proof; service role table.';
COMMENT ON COLUMN public.openwa_deferred_events.verification_source IS
  'Source of account/session-native pairing proof. Only openwa_reverse_lid is accepted.';

CREATE INDEX openwa_deferred_retention_idx
  ON public.openwa_deferred_events (state,updated_at)
  WHERE state IN ('completed','review');

-- Cleanup is server-only, bounded and cannot delete in-flight or pending
-- messages. Completed queue metadata ages out after 30 days, operator-review
-- rows after 90 days. No auto cleanup of pending/leased work.
CREATE FUNCTION public.prune_openwa_deferred_events(p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN
    RAISE EXCEPTION 'Invalid OpenWA deferred prune limit' USING ERRCODE='22023';
  END IF;
  WITH expired AS (
    SELECT id FROM public.openwa_deferred_events
    WHERE (state='completed' AND completed_at<now()-interval '30 days')
       OR (state='review' AND updated_at<now()-interval '90 days')
    ORDER BY updated_at ASC LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.openwa_deferred_events j
    USING expired e WHERE j.id=e.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_openwa_deferred_events(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prune_openwa_deferred_events(integer) TO service_role;

-- The original claim RPC from migration 179 predates the additional
-- provider-verification columns. Recreate with an extended return type in
-- this additive migration; migration 179 remains untouched.
DROP FUNCTION public.claim_openwa_deferred_events(integer);
CREATE FUNCTION public.claim_openwa_deferred_events(p_limit integer DEFAULT 5)
RETURNS TABLE (
  job_id uuid,
  account_id uuid,
  connection_id uuid,
  session_id text,
  own_phone_identity text,
  instance_id text,
  event_kind text,
  provider_message_id text,
  native_chat_id text,
  verified_phone text,
  verification_source text,
  verified_at timestamptz,
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
    q.own_phone_identity,q.instance_id,q.event_kind,
    q.provider_message_id,q.native_chat_id,
    q.verified_phone,q.verification_source,q.verified_at,
    q.normalized_payload,q.attempt_count,q.lease_token;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_openwa_deferred_events(integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_openwa_deferred_events(integer)
  TO service_role;
