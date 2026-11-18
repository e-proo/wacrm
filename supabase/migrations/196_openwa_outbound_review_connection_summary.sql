-- All current and future OpenWA sessions: one tenant-scoped summary RPC.
-- Read only; no transport dispatch, status rewrite, or implicit review.
CREATE FUNCTION public.list_openwa_outbound_review_counts(p_account_id uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $fn$
  SELECT coalesce(
    jsonb_agg(jsonb_build_object(
      'connection_id', c.id,
      'unreviewed_count', coalesce(s.unreviewed,0),
      'reviewed_uncertain_count', coalesce(s.reviewed,0)
    ) ORDER BY c.created_at DESC),
    '[]'::jsonb
  )
  FROM public.whatsapp_connections c
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE r.message_id IS NULL) AS unreviewed,
           count(*) FILTER (WHERE r.message_id IS NOT NULL) AS reviewed
    FROM public.messages m
    INNER JOIN public.conversations v
      ON v.id=m.conversation_id AND v.account_id=p_account_id
    LEFT JOIN public.openwa_outbound_operator_reviews r
      ON r.message_id=m.id AND r.account_id=p_account_id
         AND r.connection_id=c.id
    WHERE m.connection_id=c.id
      AND m.provider='openwa'
      AND m.status='sending'
      AND m.provider_message_id IS NULL
  ) s ON TRUE
  WHERE c.account_id=p_account_id
    AND c.provider='openwa'
    AND c.archived_at IS NULL
$fn$;
REVOKE ALL ON FUNCTION public.list_openwa_outbound_review_counts(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_openwa_outbound_review_counts(uuid)
  TO service_role;
COMMENT ON FUNCTION public.list_openwa_outbound_review_counts(uuid) IS
  'Service-only read-only review counts for every present and future account-owned OpenWA connection.';
