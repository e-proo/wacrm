-- OW-7 — stable WACRM outbound send identity before provider calls.
-- Additive only; preserves legacy message_id/provider fields.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS outbound_idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_outbound_idempotency
  ON public.messages(conversation_id, outbound_idempotency_key)
  WHERE outbound_idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.messages.outbound_idempotency_key IS
  'Stable WACRM-generated/client-stable outbound identity. Prevents duplicate provider sends and preserves ambiguous outcomes for reconciliation.';
