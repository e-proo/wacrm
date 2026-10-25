-- OW-5: durable server-only reservation for OpenWA webhook delivery identities.
-- Business processing remains in WACRM; this table only prevents duplicate
-- provider delivery/retry from being processed more than once.

CREATE TABLE public.whatsapp_webhook_event_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('meta_cloud', 'openwa')),
  provider_event_id text NOT NULL CHECK (length(btrim(provider_event_id)) > 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_webhook_event_receipts_identity_unique
    UNIQUE (connection_id, provider, provider_event_id)
);

CREATE INDEX whatsapp_webhook_event_receipts_account_received_idx
  ON public.whatsapp_webhook_event_receipts (account_id, received_at DESC);

ALTER TABLE public.whatsapp_webhook_event_receipts ENABLE ROW LEVEL SECURITY;

-- Webhook reservation/processing uses the server-side service role. Keep the
-- receipt ledger completely outside the browser/client data plane.
REVOKE ALL ON TABLE public.whatsapp_webhook_event_receipts FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.whatsapp_webhook_event_receipts TO service_role;

CREATE POLICY whatsapp_webhook_event_receipts_deny_select
  ON public.whatsapp_webhook_event_receipts FOR SELECT
  TO anon, authenticated
  USING (false);

CREATE POLICY whatsapp_webhook_event_receipts_deny_insert
  ON public.whatsapp_webhook_event_receipts FOR INSERT
  TO anon, authenticated
  WITH CHECK (false);

CREATE POLICY whatsapp_webhook_event_receipts_deny_update
  ON public.whatsapp_webhook_event_receipts FOR UPDATE
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY whatsapp_webhook_event_receipts_deny_delete
  ON public.whatsapp_webhook_event_receipts FOR DELETE
  TO anon, authenticated
  USING (false);
