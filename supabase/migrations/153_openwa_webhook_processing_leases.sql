-- OW-12 webhook recovery: lease a verified event until its synchronous
-- processing completes. No provider payload, credentials, or media bytes
-- are stored in this ledger. This is additive to migration 147.
ALTER TABLE public.whatsapp_webhook_event_receipts
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_token uuid,
  ADD COLUMN IF NOT EXISTS processing_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE public.whatsapp_webhook_event_receipts
  ADD CONSTRAINT openwa_webhook_processing_attempts_nonnegative
  CHECK (processing_attempts >= 0);

CREATE INDEX IF NOT EXISTS idx_openwa_webhook_unfinished_receipts
  ON public.whatsapp_webhook_event_receipts (connection_id, received_at)
  WHERE provider = 'openwa' AND processed_at IS NULL;

COMMENT ON COLUMN public.whatsapp_webhook_event_receipts.processing_token IS
  'Server-only CAS owner of one HMAC-verified webhook processing lease; not a provider credential.';
COMMENT ON COLUMN public.whatsapp_webhook_event_receipts.processing_started_at IS
  'When the current lease began; nullable to allow retry after a failed attempt.';
COMMENT ON COLUMN public.whatsapp_webhook_event_receipts.processing_attempts IS
  'Bounded observability count for webhook delivery attempts; never triggers WhatsApp outbound resend.';
