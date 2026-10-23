-- ============================================================
-- 143_whatsapp_provider_neutral_connections.sql
-- OW-1 — Provider-neutral WhatsApp connection/data model
--
-- Additive compatibility migration:
--   * introduces account-scoped whatsapp_connections
--   * deterministically mirrors existing Meta whatsapp_config rows
--   * adds provider-neutral message/broadcast correlation fields
--   * preserves all existing Meta columns and runtime behavior
--   * adds tenant-scoped RLS for connection administration
--
-- This migration does NOT route traffic to OpenWA and does NOT move
-- or expose provider credentials. Existing whatsapp_config remains the
-- Meta credential source until a later explicit cutover phase.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('meta_cloud', 'openwa')),
  display_name TEXT,
  phone_identity TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (
    status IN (
      'creating', 'waiting_qr', 'authenticating', 'connected', 'ready',
      'disconnected', 'reconnecting', 'restricted', 'logged_out', 'failed'
    )
  ),
  provider_external_id TEXT,
  session_id TEXT,
  instance_id TEXT,
  engine TEXT CHECK (engine IS NULL OR engine IN ('whatsapp-web.js', 'baileys')),
  provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  connected_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  restricted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_connections_provider_shape CHECK (
    (provider = 'meta_cloud' AND session_id IS NULL AND instance_id IS NULL AND engine IS NULL)
    OR provider = 'openwa'
  )
);

ALTER TABLE public.whatsapp_connections ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON public.whatsapp_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- One Meta connection mirrors the current one-config-per-account invariant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_connections_meta_account
  ON public.whatsapp_connections(account_id)
  WHERE provider = 'meta_cloud';

-- OpenWA session identity is tenant-scoped; never resolve a session globally.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_connections_openwa_account_session
  ON public.whatsapp_connections(account_id, session_id)
  WHERE provider = 'openwa' AND session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_account_provider_status
  ON public.whatsapp_connections(account_id, provider, status);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_account_provider_external
  ON public.whatsapp_connections(account_id, provider, provider_external_id)
  WHERE provider_external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_account_instance_session
  ON public.whatsapp_connections(account_id, instance_id, session_id)
  WHERE provider = 'openwa';

-- Deterministic/idempotent compatibility backfill for current Meta configs.
-- No credentials are copied. phone_number_id is routing identity only.
INSERT INTO public.whatsapp_connections (
  account_id,
  provider,
  phone_identity,
  status,
  provider_external_id,
  connected_at,
  created_at,
  updated_at,
  provider_metadata
)
SELECT
  wc.account_id,
  'meta_cloud',
  NULL,
  CASE WHEN wc.status = 'connected' THEN 'connected' ELSE 'disconnected' END,
  wc.phone_number_id,
  wc.connected_at,
  COALESCE(wc.created_at, NOW()),
  COALESCE(wc.updated_at, NOW()),
  jsonb_build_object('legacy_whatsapp_config_id', wc.id::text)
FROM public.whatsapp_config wc
WHERE NOT EXISTS (
  SELECT 1
  FROM public.whatsapp_connections c
  WHERE c.account_id = wc.account_id
    AND c.provider = 'meta_cloud'
);

-- Provider-neutral message identity. Existing message_id remains untouched.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES public.whatsapp_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provider TEXT,
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messages_provider_check'
      AND conrelid = 'public.messages'::regclass
  ) THEN
    ALTER TABLE public.messages
      ADD CONSTRAINT messages_provider_check
      CHECK (provider IS NULL OR provider IN ('meta_cloud', 'openwa'));
  END IF;
END $$;

-- Mirror legacy Meta IDs without changing legacy readers/writers.
UPDATE public.messages m
SET provider = 'meta_cloud',
    provider_message_id = m.message_id,
    connection_id = c.id
FROM public.conversations conv
JOIN public.whatsapp_connections c
  ON c.account_id = conv.account_id
 AND c.provider = 'meta_cloud'
WHERE m.conversation_id = conv.id
  AND m.message_id IS NOT NULL
  AND m.provider IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_connection_created
  ON public.messages(connection_id, created_at DESC)
  WHERE connection_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_provider_connection_message
  ON public.messages(provider, connection_id, provider_message_id)
  WHERE provider IS NOT NULL
    AND connection_id IS NOT NULL
    AND provider_message_id IS NOT NULL;

-- Preserve whatsapp_message_id while adding neutral broadcast correlation.
ALTER TABLE public.broadcast_recipients
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES public.whatsapp_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provider TEXT,
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'broadcast_recipients_provider_check'
      AND conrelid = 'public.broadcast_recipients'::regclass
  ) THEN
    ALTER TABLE public.broadcast_recipients
      ADD CONSTRAINT broadcast_recipients_provider_check
      CHECK (provider IS NULL OR provider IN ('meta_cloud', 'openwa'));
  END IF;
END $$;

UPDATE public.broadcast_recipients br
SET provider = 'meta_cloud',
    provider_message_id = br.whatsapp_message_id,
    connection_id = c.id
FROM public.broadcasts b
JOIN public.whatsapp_connections c
  ON c.account_id = b.account_id
 AND c.provider = 'meta_cloud'
WHERE br.broadcast_id = b.id
  AND br.whatsapp_message_id IS NOT NULL
  AND br.provider IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_recipients_provider_connection_message
  ON public.broadcast_recipients(provider, connection_id, provider_message_id)
  WHERE provider IS NOT NULL
    AND connection_id IS NOT NULL
    AND provider_message_id IS NOT NULL;

-- Connection rows are settings-class data: viewers may inspect non-secret
-- connection state, but only admins+ may create/mutate/delete connections.
DROP POLICY IF EXISTS whatsapp_connections_select ON public.whatsapp_connections;
DROP POLICY IF EXISTS whatsapp_connections_insert ON public.whatsapp_connections;
DROP POLICY IF EXISTS whatsapp_connections_update ON public.whatsapp_connections;
DROP POLICY IF EXISTS whatsapp_connections_delete ON public.whatsapp_connections;

CREATE POLICY whatsapp_connections_select
  ON public.whatsapp_connections FOR SELECT
  USING (public.is_account_member(account_id));

CREATE POLICY whatsapp_connections_insert
  ON public.whatsapp_connections FOR INSERT
  WITH CHECK (public.is_account_member(account_id, 'admin'));

CREATE POLICY whatsapp_connections_update
  ON public.whatsapp_connections FOR UPDATE
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));

CREATE POLICY whatsapp_connections_delete
  ON public.whatsapp_connections FOR DELETE
  USING (public.is_account_member(account_id, 'admin'));

COMMENT ON TABLE public.whatsapp_connections IS
  'Provider-neutral WhatsApp connection registry. Credentials remain in provider-specific server-only stores during OW-1.';
COMMENT ON COLUMN public.whatsapp_connections.provider_metadata IS
  'Non-secret provider metadata only. Never store access tokens, verify secrets, session secrets, or API keys here.';
COMMENT ON COLUMN public.messages.message_id IS
  'Legacy Meta-compatible provider message id. Preserve until explicit compatibility cutover.';
COMMENT ON COLUMN public.broadcast_recipients.whatsapp_message_id IS
  'Legacy Meta-compatible broadcast message id. Preserve until explicit compatibility cutover.';
