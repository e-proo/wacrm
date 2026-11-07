BEGIN;

DO $openwa_chat_identity$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
      AND column_name = 'provider_chat_id'
  ) THEN
    RAISE EXCEPTION 'messages.provider_chat_id is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messages_openwa_provider_chat_id_check'
      AND conrelid = 'public.messages'::regclass
  ) THEN
    RAISE EXCEPTION 'OpenWA JID format constraint is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'messages'
      AND indexname = 'idx_messages_openwa_chat_identity_lookup'
  ) THEN
    RAISE EXCEPTION 'OpenWA account-scoped chat identity index is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.messages'::regclass) THEN
    RAISE EXCEPTION 'RLS unexpectedly disabled on messages';
  END IF;
  RAISE NOTICE 'OpenWA inbound chat identity smoke passed';
END $openwa_chat_identity$;

ROLLBACK;
