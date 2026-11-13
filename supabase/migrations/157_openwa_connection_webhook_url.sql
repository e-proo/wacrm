-- Store the per-session WACRM signed webhook callback only after OpenWA confirms it.
-- Existing service-role-only credential RLS policies and grants remain in force.
ALTER TABLE public.whatsapp_connection_credentials
  ADD COLUMN IF NOT EXISTS webhook_url TEXT;

COMMENT ON COLUMN public.whatsapp_connection_credentials.webhook_url IS
  'Validated WACRM HTTPS callback, verified on the upstream OpenWA session; service-only read/write.';

REVOKE ALL ON TABLE public.whatsapp_connection_credentials FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.whatsapp_connection_credentials TO service_role;
