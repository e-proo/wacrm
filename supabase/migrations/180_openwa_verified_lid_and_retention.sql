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
