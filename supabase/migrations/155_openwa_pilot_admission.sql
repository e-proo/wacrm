-- OW-13 PREPARATION ONLY: inert, server-only pilot recipient admission ledger.
-- No rows are seeded; no connection is enabled; Meta behavior is unchanged.
-- Runtime enforcement is separately gated by OPENWA_PILOT_MODE=enforce.
-- No plaintext recipient, message content, QR, session or API credential stored.

CREATE TABLE public.whatsapp_openwa_pilot_allowlist (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  recipient_hash text NOT NULL CHECK (recipient_hash ~ '^[0-9a-f]{64}$'),
  workload text NOT NULL CHECK (workload IN ('manual', 'automation', 'broadcast', 'agent', 'api')),
  active boolean NOT NULL DEFAULT false,
  approved_by uuid NOT NULL REFERENCES auth.users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, connection_id, recipient_hash, workload),
  CHECK (expires_at > approved_at)
);

CREATE INDEX whatsapp_openwa_pilot_allowlist_active_idx
  ON public.whatsapp_openwa_pilot_allowlist (account_id, connection_id, recipient_hash, workload, expires_at)
  WHERE active;

CREATE TABLE public.whatsapp_openwa_pilot_admission_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  recipient_hash text CHECK (recipient_hash IS NULL OR recipient_hash ~ '^[0-9a-f]{64}$'),
  workload text NOT NULL CHECK (workload IN ('manual', 'automation', 'broadcast', 'agent', 'api')),
  allowed boolean NOT NULL,
  reason text NOT NULL CHECK (reason IN ('approved', 'not_allowlisted', 'invalid_identity')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX whatsapp_openwa_pilot_admission_scope_idx
  ON public.whatsapp_openwa_pilot_admission_events (account_id, connection_id, created_at DESC);

-- Deny client access explicitly; privileges are service-only. Even an
-- authenticated tenant admin must use a separately reviewed server action.
ALTER TABLE public.whatsapp_openwa_pilot_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_openwa_pilot_admission_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_openwa_pilot_allowlist FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.whatsapp_openwa_pilot_admission_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_openwa_pilot_allowlist TO service_role;
GRANT SELECT, INSERT ON public.whatsapp_openwa_pilot_admission_events TO service_role;

-- Only WACRM service-role may invoke this function after the transport router
-- has verified the caller's account and connection. SECURITY INVOKER retains
-- the service-role privilege boundary instead of using SECURITY DEFINER.
-- Cross-account allowlist rows can never authorize a different connection:
-- both the connection and policy are joined on account_id + connection_id.
CREATE FUNCTION public.check_openwa_pilot_admission(
  p_account_id uuid, p_connection_id uuid, p_recipient_hash text, p_workload text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $func$
DECLARE
  v_allowed boolean := false;
  v_valid_hash boolean;
  v_reason text;
BEGIN
  IF p_account_id IS NULL OR p_connection_id IS NULL
    OR p_workload NOT IN ('manual', 'automation', 'broadcast', 'agent', 'api')
    OR p_workload IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_request');
  END IF;

  -- If the connection is absent, archived, wrong tenant/provider or not ready,
  -- deny without writing an audit event with an invalid account/connection FK.
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_connections c
    WHERE c.id = p_connection_id
      AND c.account_id = p_account_id
      AND c.provider = 'openwa'
      AND c.archived_at IS NULL
      AND c.status IN ('ready', 'connected')
  ) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'connection_scope_mismatch');
  END IF;

  v_valid_hash := p_recipient_hash IS NOT NULL AND p_recipient_hash ~ '^[0-9a-f]{64}$';
  IF v_valid_hash THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.whatsapp_openwa_pilot_allowlist a
      JOIN public.whatsapp_connections c
        ON c.id = a.connection_id AND c.account_id = a.account_id
      WHERE a.account_id = p_account_id
        AND a.connection_id = p_connection_id
        AND a.recipient_hash = p_recipient_hash
        AND a.workload = p_workload
        AND a.active
        AND a.expires_at > now()
        AND c.provider = 'openwa'
        AND c.archived_at IS NULL
    ) INTO v_allowed;
  END IF;

  v_reason := CASE
    WHEN NOT v_valid_hash THEN 'invalid_identity'
    WHEN v_allowed THEN 'approved'
    ELSE 'not_allowlisted'
  END;

  INSERT INTO public.whatsapp_openwa_pilot_admission_events
    (account_id, connection_id, recipient_hash, workload, allowed, reason)
  VALUES
    (p_account_id, p_connection_id,
     CASE WHEN v_valid_hash THEN p_recipient_hash ELSE NULL END,
     p_workload, v_allowed, v_reason);

  RETURN jsonb_build_object('allowed', v_allowed, 'reason', v_reason);
END
$func$;

REVOKE ALL ON FUNCTION public.check_openwa_pilot_admission(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_openwa_pilot_admission(uuid, uuid, text, text)
  TO service_role;

COMMENT ON TABLE public.whatsapp_openwa_pilot_allowlist IS
  'OW-13 PREP: server-only, hashed recipient/workload allowlist. Default inactive; NOT pilot activation.';
COMMENT ON TABLE public.whatsapp_openwa_pilot_admission_events IS
  'OW-13 PREP: tenant-scoped server-only admission audit without recipient identifiers.';
