-- New, additive migration. Explicit admin-only reissue of a pending Change Request
-- approval PIN; never re-create the business proposal or persist plaintext.
ALTER TABLE public.change_requests
  ADD COLUMN IF NOT EXISTS admin_pin_reissued_at timestamptz,
  ADD COLUMN IF NOT EXISTS admin_pin_reissue_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.reissue_pending_change_request_approval_pin(
  p_account_id uuid,
  p_change_request_id uuid
)
RETURNS TABLE(request_code integer, confirmation_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
DECLARE
  v_request public.change_requests%rowtype;
  v_pin text;
  v_b0 integer;
  v_b1 integer;
BEGIN
  IF p_account_id IS NULL OR p_change_request_id IS NULL THEN
    RAISE EXCEPTION 'CHANGE_REQUEST_INVALID_INPUT' USING ERRCODE='P0001';
  END IF;
  SELECT cr.* INTO v_request
    FROM public.change_requests cr
    WHERE cr.account_id=p_account_id AND cr.id=p_change_request_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHANGE_REQUEST_NOT_FOUND' USING ERRCODE='P0002';
  END IF;
  IF v_request.status <> 'pending' OR v_request.expires_at <= now() THEN
    RAISE EXCEPTION 'CHANGE_REQUEST_NOT_PENDING' USING ERRCODE='P0001';
  END IF;
  IF v_request.approval_attempts >= 5 THEN
    RAISE EXCEPTION 'CHANGE_REQUEST_PIN_ATTEMPTS_LOCKED' USING ERRCODE='P0001';
  END IF;
  IF v_request.admin_pin_reissued_at IS NOT NULL
    AND v_request.admin_pin_reissued_at > now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'CHANGE_REQUEST_PIN_REISSUE_COOLDOWN' USING ERRCODE='P0001';
  END IF;
  IF v_request.admin_pin_reissue_count >= 5 THEN
    RAISE EXCEPTION 'CHANGE_REQUEST_PIN_REISSUE_LIMIT' USING ERRCODE='P0001';
  END IF;

  v_b0 := get_byte(gen_random_bytes(2), 0);
  v_b1 := get_byte(gen_random_bytes(2), 1);
  v_pin := (1000 + ((v_b0 * 256 + v_b1) % 9000))::text;

  UPDATE public.change_requests cr
     SET confirmation_code_hash=crypt(v_pin, gen_salt('bf', 8)),
         admin_pin_reissued_at=now(),
         admin_pin_reissue_count=v_request.admin_pin_reissue_count + 1
   WHERE cr.id=v_request.id AND cr.account_id=p_account_id AND cr.status='pending';

  PERFORM public.append_service_activity_event(
    p_account_id,
    'change_request',
    v_request.id,
    'change_request.admin_pin_reissued',
    'service',
    'trusted_admin_delivery',
    jsonb_build_object('code', v_request.code, 'reissue_count', v_request.admin_pin_reissue_count + 1)
  );
  request_code := v_request.code;
  confirmation_code := v_pin;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.reissue_pending_change_request_approval_pin(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reissue_pending_change_request_approval_pin(uuid,uuid)
  TO service_role;

COMMENT ON FUNCTION public.reissue_pending_change_request_approval_pin(uuid,uuid)
IS 'Service-only, rate-limited rotation of a pending Change Request approval PIN. Never exposes PIN to browser, logs, CRM messages, or durable notifications.';

-- OTP-verified trusted admins form an explicit TEST Pilot consent class.
ALTER TABLE public.whatsapp_openwa_pilot_allowlist
  DROP CONSTRAINT whatsapp_openwa_pilot_allowlist_consent_basis_check;
ALTER TABLE public.whatsapp_openwa_pilot_allowlist
  ADD CONSTRAINT whatsapp_openwa_pilot_allowlist_consent_basis_check
    CHECK (consent_basis IN ('verified_inbound','phone_call','trusted_admin_verified'));
