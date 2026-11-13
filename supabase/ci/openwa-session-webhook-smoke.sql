BEGIN;

-- Per-session OpenWA callback URL must remain inside the service-only
-- credential boundary, never selectable directly by browser roles.
DO $webhook$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='whatsapp_connection_credentials'
      AND column_name='webhook_url'
  ) THEN
    RAISE EXCEPTION 'per-session webhook_url migration missing';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class
          WHERE oid='public.whatsapp_connection_credentials'::regclass) THEN
    RAISE EXCEPTION 'credential RLS unexpectedly disabled';
  END IF;

  IF has_table_privilege('anon','public.whatsapp_connection_credentials','SELECT')
     OR has_table_privilege('authenticated','public.whatsapp_connection_credentials','SELECT')
     OR has_table_privilege('anon','public.whatsapp_connection_credentials','UPDATE')
     OR has_table_privilege('authenticated','public.whatsapp_connection_credentials','UPDATE') THEN
    RAISE EXCEPTION 'client privilege escalation on OpenWA credentials';
  END IF;

  IF NOT has_table_privilege('service_role','public.whatsapp_connection_credentials','SELECT')
     OR NOT has_table_privilege('service_role','public.whatsapp_connection_credentials','UPDATE') THEN
    RAISE EXCEPTION 'service-only OpenWA credentials missing expected privileges';
  END IF;
END
$webhook$;

ROLLBACK;
