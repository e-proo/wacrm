BEGIN;

-- OW-4 acceptance (schema/security): clean replay must preserve the
-- account-scoped session registry and server-only credentials.
DO $ow4$
DECLARE
  v_status_check text;
BEGIN
  IF to_regclass('public.whatsapp_connections') IS NULL THEN
    RAISE EXCEPTION 'OW-4: whatsapp_connections table is missing';
  END IF;
  IF to_regclass('public.whatsapp_connection_credentials') IS NULL THEN
    RAISE EXCEPTION 'OW-4: encrypted credential table is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class
          WHERE oid = 'public.whatsapp_connections'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class
             WHERE oid = 'public.whatsapp_connection_credentials'::regclass)
  THEN
    RAISE EXCEPTION 'OW-4: session or credentials RLS is disabled';
  END IF;
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'whatsapp_connections') <> 4 THEN
    RAISE EXCEPTION 'OW-4: session registry policy count changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'whatsapp_connections'
      AND indexname = 'idx_whatsapp_connections_openwa_account_session'
  ) THEN
    RAISE EXCEPTION 'OW-4: account/session uniqueness index is missing';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_status_check
  FROM pg_constraint
  WHERE conrelid = 'public.whatsapp_connections'::regclass
    AND conname = 'whatsapp_connections_status_check';
  IF v_status_check IS NULL
    OR position('waiting_qr' IN v_status_check) = 0
    OR position('ready' IN v_status_check) = 0
    OR position('restricted' IN v_status_check) = 0
    OR position('logged_out' IN v_status_check) = 0
  THEN
    RAISE EXCEPTION 'OW-4: normalized lifecycle state constraint is missing';
  END IF;

  IF has_table_privilege('anon', 'public.whatsapp_connection_credentials', 'SELECT')
    OR has_table_privilege('authenticated', 'public.whatsapp_connection_credentials', 'SELECT')
  THEN
    RAISE EXCEPTION 'OW-4: credential material can be read by a client role';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.whatsapp_connection_credentials', 'SELECT')
    OR NOT has_table_privilege('service_role', 'public.whatsapp_connection_credentials', 'INSERT')
  THEN
    RAISE EXCEPTION 'OW-4: server credentials access is missing';
  END IF;

  RAISE NOTICE 'OW-4 tenant-scoped session/credentials schema gate passed';
END $ow4$;

ROLLBACK;
