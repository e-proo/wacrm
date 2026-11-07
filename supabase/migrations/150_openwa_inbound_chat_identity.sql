-- Keep the original OpenWA 1:1 destination apart from CRM phone fields.
-- LID digits are not MSISDN digits: never coerce them to @c.us for replies.
-- Existing rows remain NULL and must not be used for automatic routing.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS provider_chat_id text;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_openwa_provider_chat_id_check
  CHECK (
    provider_chat_id IS NULL OR
    (provider = 'openwa' AND provider_chat_id ~ '^[0-9]{5,20}@(c[.]us|lid)$')
  );

CREATE INDEX IF NOT EXISTS idx_messages_openwa_chat_identity_lookup
  ON public.messages (conversation_id, connection_id, created_at DESC)
  WHERE provider = 'openwa' AND sender_type = 'customer';

COMMENT ON COLUMN public.messages.provider_chat_id IS
  'Validated OpenWA one-to-one WhatsApp chat JID (@c.us or @lid); not a phone number. Scoped by the inbound message connection; never infer from LID digits.';
