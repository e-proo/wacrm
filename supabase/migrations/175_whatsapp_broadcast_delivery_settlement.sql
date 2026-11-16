-- Additive reconciliation state for provider-neutral campaign sends.
-- Applied migration files are immutable. No ambiguous provider send is retryable by status alone.
ALTER TABLE public.broadcast_recipients
  DROP CONSTRAINT IF EXISTS broadcast_recipients_status_check;
ALTER TABLE public.broadcast_recipients
  ADD CONSTRAINT broadcast_recipients_status_check
  CHECK (status IN ('pending','sending','requires_reconciliation','sent','delivered','read','replied','failed'));
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_unsettled
  ON public.broadcast_recipients (broadcast_id, status)
  WHERE status IN ('pending','sending','requires_reconciliation');
COMMENT ON COLUMN public.broadcast_recipients.status IS
  'sending is reserved before provider dispatch; requires_reconciliation must never be blindly retried';
