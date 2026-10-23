-- OW-3 hardening: make the server-only credential boundary explicit to RLS
-- advisors while retaining zero client access. Table privileges remain revoked.

CREATE POLICY whatsapp_connection_credentials_deny_select
  ON public.whatsapp_connection_credentials FOR SELECT
  TO anon, authenticated
  USING (false);

CREATE POLICY whatsapp_connection_credentials_deny_insert
  ON public.whatsapp_connection_credentials FOR INSERT
  TO anon, authenticated
  WITH CHECK (false);

CREATE POLICY whatsapp_connection_credentials_deny_update
  ON public.whatsapp_connection_credentials FOR UPDATE
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY whatsapp_connection_credentials_deny_delete
  ON public.whatsapp_connection_credentials FOR DELETE
  TO anon, authenticated
  USING (false);
