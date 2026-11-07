-- OW-4 clean-replay hardening: make the server-only OpenWA credential
-- permissions explicit. Long-lived TEST inherited these grants, but a fresh
-- database replay did not. Never broaden the client credential boundary.
--
-- This is an additive follow-up to the already-applied migration 145.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.whatsapp_connection_credentials
  TO service_role;

-- Preserve the existing explicit deny boundary for browser/API client roles.
REVOKE ALL ON TABLE public.whatsapp_connection_credentials
  FROM anon, authenticated;
