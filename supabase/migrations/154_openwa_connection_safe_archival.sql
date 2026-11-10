-- OW-12: remove an OpenWA session from WACRM without destroying the
-- historic messages, signed webhook ledger, guardrail audit, or broadcasts.
-- The gateway process / WhatsApp device is NOT deleted or logged out.
ALTER TABLE public.whatsapp_connections
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid;

CREATE INDEX IF NOT EXISTS idx_openwa_live_connections_account
  ON public.whatsapp_connections (account_id, provider, updated_at DESC)
  WHERE provider = 'openwa' AND archived_at IS NULL;

COMMENT ON COLUMN public.whatsapp_connections.archived_at IS
  'Admin removed this OpenWA connection from WACRM. Historical rows and event evidence remain linked.';
COMMENT ON COLUMN public.whatsapp_connections.archived_by IS
  'User ID of the WACRM admin who archived this OpenWA connection; no provider credentials.';

-- Only server-side service_role may invoke this atomic, tenant-scoped
-- operation. SECURITY INVOKER preserves the caller privileges; do not use
-- SECURITY DEFINER or broaden authenticated/anon grants.
CREATE OR REPLACE FUNCTION public.archive_openwa_connection(
  p_account_id uuid,
  p_connection_id uuid,
  p_actor_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_connection public.whatsapp_connections%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL OR p_account_id IS NULL OR p_connection_id IS NULL THEN
    RETURN 'invalid_request';
  END IF;

  SELECT * INTO v_connection
  FROM public.whatsapp_connections
  WHERE id = p_connection_id
    AND account_id = p_account_id
    AND provider = 'openwa'
  FOR UPDATE;

  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_connection.archived_at IS NOT NULL THEN RETURN 'already_archived'; END IF;

  -- Never discard credentials while a provider send could have succeeded,
  -- or before outstanding signed events are reconciled.
  IF EXISTS (
    SELECT 1 FROM public.messages
    WHERE connection_id = p_connection_id
      AND status = 'sending'
  ) THEN
    RETURN 'pending_sends';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.whatsapp_webhook_event_receipts
    WHERE connection_id = p_connection_id
      AND processed_at IS NULL
  ) THEN
    RETURN 'pending_webhooks';
  END IF;

  -- Retain the connection ID as a historical anchor; revoke secrets
  -- atomically in the same transaction. Never DELETE the parent row:
  -- messages/broadcasts have SET NULL FKs and audit receipts CASCADE.
  UPDATE public.whatsapp_connections SET
    archived_at = now(),
    archived_by = p_actor_id
  WHERE id = p_connection_id AND account_id = p_account_id AND provider = 'openwa'
    AND archived_at IS NULL;

  DELETE FROM public.whatsapp_connection_credentials
  WHERE connection_id = p_connection_id
    AND account_id = p_account_id
    AND provider = 'openwa';

  RETURN 'archived';
END
$function$;

REVOKE ALL ON FUNCTION public.archive_openwa_connection(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_openwa_connection(uuid, uuid, uuid)
  TO service_role;
