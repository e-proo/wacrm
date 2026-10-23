-- ============================================================
-- 145_openwa_connection_credentials.sql
-- OW-3 — OpenWA server-only credential boundary
--
-- Credentials are deliberately separated from whatsapp_connections so
-- provider_metadata remains non-secret. Runtime access is service-role only;
-- tenant/admin mutation must go through audited server-side application code.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_connection_credentials (
  connection_id UUID PRIMARY KEY REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'openwa'),
  base_url TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  webhook_secret_encrypted TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_connection_credentials_base_url_nonempty CHECK (length(trim(base_url)) > 0),
  CONSTRAINT whatsapp_connection_credentials_api_key_nonempty CHECK (length(trim(api_key_encrypted)) > 0)
);

ALTER TABLE public.whatsapp_connection_credentials ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON public.whatsapp_connection_credentials;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.whatsapp_connection_credentials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_connection_credentials_account_connection
  ON public.whatsapp_connection_credentials(account_id, connection_id);

-- Do not grant authenticated/anon privileges and do not add user-facing RLS
-- policies. The service role bypasses RLS; application resolvers MUST still
-- bind every lookup to both account_id and connection_id before decrypting.
REVOKE ALL ON TABLE public.whatsapp_connection_credentials FROM anon, authenticated;

COMMENT ON TABLE public.whatsapp_connection_credentials IS
  'Server-only encrypted OpenWA credential store. Never expose through client APIs or logs.';
COMMENT ON COLUMN public.whatsapp_connection_credentials.api_key_encrypted IS
  'AES-GCM encrypted OpenWA API key using the existing server ENCRYPTION_KEY boundary.';
COMMENT ON COLUMN public.whatsapp_connection_credentials.webhook_secret_encrypted IS
  'AES-GCM encrypted OpenWA webhook verification secret; consumed by OW-5.';
COMMENT ON COLUMN public.whatsapp_connection_credentials.base_url IS
  'Validated OpenWA service origin. Runtime code must reject unsafe/private targets unless explicitly allowlisted.';
