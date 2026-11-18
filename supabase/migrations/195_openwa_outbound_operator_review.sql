-- OW-9/OW-13 TEST: operator review for ambiguous outbound reservations.
-- A review NEVER marks a message delivered/failed, retries, or erases its
-- idempotency key. The evidence and uncertainty remain available for audits.
CREATE TABLE public.openwa_outbound_operator_reviews (
  message_id uuid PRIMARY KEY REFERENCES public.messages(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  reviewed_by uuid NOT NULL,
  finding text NOT NULL CHECK (finding IN ('seen_on_whatsapp','not_seen_on_whatsapp','still_uncertain')),
  review_note text NOT NULL CHECK (char_length(review_note) BETWEEN 12 AND 500),
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_openwa_outbound_operator_reviews_account
  ON public.openwa_outbound_operator_reviews(account_id, connection_id, reviewed_at DESC);
ALTER TABLE public.openwa_outbound_operator_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.openwa_outbound_operator_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.openwa_outbound_operator_reviews TO service_role;
COMMENT ON TABLE public.openwa_outbound_operator_reviews IS
  'Admin-attested TEST ambiguous-send reviews. Never proof of provider delivery; original message status and idempotency reservation remain unchanged.';

CREATE FUNCTION public.get_openwa_outbound_review_queue(
  p_account_id uuid, p_connection_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $fn$
DECLARE v_exists boolean; v_pending integer; v_reviewed integer; v_items jsonb;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM public.whatsapp_connections c
    WHERE c.id=p_connection_id AND c.account_id=p_account_id
      AND c.provider='openwa' AND c.archived_at IS NULL
  ) INTO v_exists;
  IF NOT v_exists THEN RETURN NULL; END IF;

  SELECT count(*) FILTER (WHERE r.message_id IS NULL),
         count(*) FILTER (WHERE r.message_id IS NOT NULL)
    INTO v_pending,v_reviewed
  FROM public.messages m
  JOIN public.conversations conv ON conv.id=m.conversation_id
    AND conv.account_id=p_account_id
  LEFT JOIN public.openwa_outbound_operator_reviews r
    ON r.message_id=m.id AND r.account_id=p_account_id
       AND r.connection_id=p_connection_id
  WHERE m.connection_id=p_connection_id AND m.provider='openwa'
    AND m.status='sending' AND m.provider_message_id IS NULL;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'message_id',q.id, 'created_at',q.created_at,
    'sender_type',q.sender_type,'content_type',q.content_type
  ) ORDER BY q.created_at DESC),'[]'::jsonb) INTO v_items
  FROM (
    SELECT m.id,m.created_at,m.sender_type,m.content_type
    FROM public.messages m
    JOIN public.conversations conv ON conv.id=m.conversation_id
      AND conv.account_id=p_account_id
    LEFT JOIN public.openwa_outbound_operator_reviews r
      ON r.message_id=m.id AND r.account_id=p_account_id
         AND r.connection_id=p_connection_id
    WHERE m.connection_id=p_connection_id AND m.provider='openwa'
      AND m.status='sending' AND m.provider_message_id IS NULL
      AND r.message_id IS NULL
    ORDER BY m.created_at DESC LIMIT 25
  ) q;
  RETURN jsonb_build_object('unreviewed_count',coalesce(v_pending,0),
     'reviewed_uncertain_count',coalesce(v_reviewed,0),'items',v_items);
END
$fn$;

CREATE FUNCTION public.acknowledge_openwa_ambiguous_outbound(
  p_account_id uuid, p_connection_id uuid, p_message_id uuid,
  p_actor uuid, p_finding text, p_review_note text, p_confirm_no_resend boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $fn$
DECLARE v_connection uuid; v_guard boolean; v_message uuid; v_reviewed uuid;
BEGIN
  IF p_account_id IS NULL OR p_connection_id IS NULL OR p_message_id IS NULL OR p_actor IS NULL
    OR p_confirm_no_resend IS DISTINCT FROM true
    OR p_finding NOT IN ('seen_on_whatsapp','not_seen_on_whatsapp','still_uncertain')
    OR p_finding IS NULL OR p_review_note IS NULL
    OR char_length(btrim(p_review_note)) NOT BETWEEN 12 AND 500
  THEN RETURN jsonb_build_object('updated',false,'reason','invalid_request'); END IF;

  -- Serialize with pause / mode-changing operations on the same connection.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_account_id::text||':'||p_connection_id::text)
  );
  SELECT c.id INTO v_connection FROM public.whatsapp_connections c
    WHERE c.account_id=p_account_id AND c.id=p_connection_id
      AND c.provider='openwa' AND c.archived_at IS NULL FOR UPDATE;
  IF v_connection IS NULL THEN
    RETURN jsonb_build_object('updated',false,'reason','connection_scope_mismatch');
  END IF;
  SELECT g.manual_paused INTO v_guard FROM public.whatsapp_connection_guardrails g
    WHERE g.account_id=p_account_id AND g.connection_id=p_connection_id FOR UPDATE;
  IF v_guard IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('updated',false,'reason','stop_required');
  END IF;

  SELECT m.id INTO v_message FROM public.messages m
    JOIN public.conversations conv ON conv.id=m.conversation_id
      AND conv.account_id=p_account_id
    WHERE m.id=p_message_id AND m.connection_id=p_connection_id
      AND m.provider='openwa' AND m.status='sending'
      AND m.provider_message_id IS NULL
      AND m.outbound_idempotency_key IS NOT NULL
      AND m.created_at <= now() - interval '10 minutes'
    FOR UPDATE OF m;
  IF v_message IS NULL THEN
    RETURN jsonb_build_object('updated',false,'reason','not_eligible');
  END IF;

  INSERT INTO public.openwa_outbound_operator_reviews
    (message_id,account_id,connection_id,reviewed_by,finding,review_note)
  VALUES (p_message_id,p_account_id,p_connection_id,p_actor,p_finding,btrim(p_review_note))
  ON CONFLICT (message_id) DO NOTHING
  RETURNING message_id INTO v_reviewed;
  IF v_reviewed IS NULL THEN
    RETURN jsonb_build_object('updated',false,'reason','already_reviewed');
  END IF;
  RETURN jsonb_build_object('updated',true,'message_still_uncertain',true,
     'no_resend',true);
END
$fn$;

REVOKE ALL ON FUNCTION public.get_openwa_outbound_review_queue(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.acknowledge_openwa_ambiguous_outbound(uuid,uuid,uuid,uuid,text,text,boolean)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_openwa_outbound_review_queue(uuid,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.acknowledge_openwa_ambiguous_outbound(uuid,uuid,uuid,uuid,text,text,boolean)
  TO service_role;
