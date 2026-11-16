-- OW-13 / SOF-66: preserve the admin-selected per-recipient
-- capacity goal across a paused approval and subsequent activation.
-- This is TEST Pilot configuration metadata, not send permission or a quota.
-- Legacy grants default to 1 so existing cohorts are not retroactively
-- forced to a higher capacity; new grant_batch defaults to 3 in the API.
-- No provider transport, idempotency or RLS policy changes.
ALTER TABLE public.whatsapp_openwa_pilot_allowlist
  ADD COLUMN messages_per_recipient integer NOT NULL DEFAULT 1
  CONSTRAINT whatsapp_openwa_pilot_messages_per_recipient_check
    CHECK (messages_per_recipient BETWEEN 1 AND 100);

COMMENT ON COLUMN public.whatsapp_openwa_pilot_allowlist.messages_per_recipient IS
  'TEST Pilot admin-selected minimum shared hour/day capacity per recipient. Checked as cohort size × value at approval and activation. Never guarantees sends and never changes first-touch/consent. Legacy grants default to one.';
