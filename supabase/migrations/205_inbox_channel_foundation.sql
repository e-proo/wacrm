-- INBOX-1.01 / SOF-76: shadow-only channel foundation (ADR-INBOX-002).
-- No auto-merge, messages move, provider calls, feature activation or fanout.
-- The existing connection registry is transport authority, not historical identity proof.
CREATE UNIQUE INDEX IF NOT EXISTS inbox_connection_account_provider_id_uidx
  ON public.whatsapp_connections(account_id,provider,id);

CREATE TABLE public.whatsapp_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('meta_cloud','openwa')),
  -- Server-only, normalized immutable OWN identity, not the contact or session.
  identity_key text NOT NULL CHECK (
    (provider='openwa' AND identity_key ~ '^e164:[1-9][0-9]{6,14}$') OR
    (provider='meta_cloud' AND identity_key ~ '^phone_number_id:[0-9]{1,32}$')
  ),
  display_name text CHECK (display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id,provider,identity_key),
  UNIQUE(account_id,provider,id)
);

CREATE TABLE public.whatsapp_channel_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  provider text NOT NULL,
  channel_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  -- Snapshot of verified route, not an authorization credential.
  session_snapshot text,
  instance_snapshot text,
  external_snapshot text,
  evidence_kind text NOT NULL,
  evidence_ref text NOT NULL CHECK(length(btrim(evidence_ref)) BETWEEN 1 AND 200),
  verified_at timestamptz NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  is_primary boolean NOT NULL DEFAULT false,
  CHECK (valid_from >= verified_at AND (valid_until IS NULL OR valid_until >= valid_from)),
  CHECK (valid_until IS NULL OR NOT is_primary),
  CHECK (
    (provider='openwa' AND evidence_kind='authenticated_openwa_status' AND nullif(btrim(session_snapshot),'') IS NOT NULL AND external_snapshot IS NULL)
    OR (provider='meta_cloud' AND evidence_kind='verified_meta_phone_number' AND session_snapshot IS NULL AND instance_snapshot IS NULL AND nullif(btrim(external_snapshot),'') IS NOT NULL)
  ),
  FOREIGN KEY(account_id,provider,channel_id)
    REFERENCES public.whatsapp_channels(account_id,provider,id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,provider,connection_id)
    REFERENCES public.whatsapp_connections(account_id,provider,id) ON DELETE RESTRICT,
  UNIQUE(account_id,provider,channel_id,connection_id,id)
);
CREATE UNIQUE INDEX inbox_membership_one_active_connection_uidx
  ON public.whatsapp_channel_memberships(account_id,connection_id) WHERE valid_until IS NULL;
CREATE UNIQUE INDEX inbox_membership_one_primary_uidx
  ON public.whatsapp_channel_memberships(account_id,channel_id) WHERE valid_until IS NULL AND is_primary;
CREATE INDEX inbox_membership_channel_idx ON public.whatsapp_channel_memberships(account_id,channel_id,valid_until);

CREATE TABLE public.inbox_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  provider text NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','pending','closed')),
  last_message_id uuid,
  last_message_at timestamptz,
  last_trusted_inbound_at timestamptz,
  unread_count_known bigint NOT NULL DEFAULT 0 CHECK(unread_count_known>=0),
  inherited_unread bigint NOT NULL DEFAULT 0 CHECK(inherited_unread>=0),
  ingest_highwater bigint NOT NULL DEFAULT 0 CHECK(ingest_highwater>=0),
  read_watermark bigint NOT NULL DEFAULT 0 CHECK(read_watermark>=0 AND read_watermark<=ingest_highwater),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(account_id,conversation_id) REFERENCES public.conversations(account_id,id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,provider,channel_id) REFERENCES public.whatsapp_channels(account_id,provider,id) ON DELETE CASCADE,
  -- Summary reference is validated by the projection writer; cannot cross the CRM parent.
  FOREIGN KEY(conversation_id,last_message_id) REFERENCES public.messages(conversation_id,id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE(account_id,conversation_id,channel_id),
  UNIQUE(account_id,provider,channel_id,conversation_id,id)
);
CREATE INDEX inbox_threads_account_channel_page_idx
  ON public.inbox_threads(account_id,channel_id,last_message_at DESC NULLS LAST,id DESC);
CREATE INDEX inbox_threads_account_page_idx
  ON public.inbox_threads(account_id,last_message_at DESC NULLS LAST,id DESC);

-- Existing rows remain canonical. Only verified historical or new ingress
-- evidence may associate a row; absence is the explicit unresolved legacy lane.
CREATE TABLE public.inbox_message_memberships (
  message_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  provider text NOT NULL,
  connection_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  evidence_kind text NOT NULL CHECK(evidence_kind IN ('verified_current_ingress','verified_historical_epoch','verified_outbound_reservation')),
  evidence_ref text NOT NULL CHECK(length(btrim(evidence_ref)) BETWEEN 1 AND 200),
  ingest_sequence bigint NOT NULL CHECK(ingest_sequence>0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(conversation_id,message_id) REFERENCES public.messages(conversation_id,id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,provider,channel_id,conversation_id,thread_id)
    REFERENCES public.inbox_threads(account_id,provider,channel_id,conversation_id,id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,provider,channel_id,connection_id,membership_id)
    REFERENCES public.whatsapp_channel_memberships(account_id,provider,channel_id,connection_id,id),
  UNIQUE(thread_id,ingest_sequence)
);
CREATE INDEX inbox_message_membership_scope_idx ON public.inbox_message_memberships(account_id,thread_id,ingest_sequence DESC);

-- Unallocated unread remains distinct from known per-channel unread. No
-- allocation or clearing is performed by installing this foundation.
CREATE TABLE public.inbox_legacy_unread (
  account_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  unread_count bigint NOT NULL CHECK(unread_count>=0),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  PRIMARY KEY(account_id,conversation_id),
  FOREIGN KEY(account_id,conversation_id) REFERENCES public.conversations(account_id,id) ON DELETE CASCADE
);

-- Never expose native identity or raw evidence to browser roles.
DO $acl$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['whatsapp_channels','whatsapp_channel_memberships','inbox_threads','inbox_message_memberships','inbox_legacy_unread'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role',t);
    EXECUTE format('CREATE POLICY inbox_server_only ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',t);
  END LOOP;
END $acl$;
GRANT SELECT, INSERT ON public.whatsapp_channels TO service_role;
GRANT UPDATE(display_name) ON public.whatsapp_channels TO service_role;
GRANT SELECT, INSERT ON public.whatsapp_channel_memberships TO service_role;
GRANT UPDATE(valid_until,is_primary) ON public.whatsapp_channel_memberships TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.inbox_threads TO service_role;
GRANT SELECT, INSERT ON public.inbox_message_memberships TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.inbox_legacy_unread TO service_role;

-- RLS does not protect TRUNCATE. Removing these unrelated destructive browser
-- grants is backwards compatible with existing REST/RPC business operations.
REVOKE TRUNCATE ON public.messages, public.conversations, public.whatsapp_connections FROM PUBLIC, anon, authenticated;

-- Protect immutable epochs, even from a trusted server caller accidentally
-- updating the historical identity/route snapshot. Close once; never reopen.
CREATE FUNCTION public.inbox_guard_membership_epoch()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public AS $$
BEGIN
  IF (to_jsonb(NEW)-'valid_until'-'is_primary') IS DISTINCT FROM
     (to_jsonb(OLD)-'valid_until'-'is_primary') OR
     (OLD.valid_until IS NOT NULL AND NEW.valid_until IS DISTINCT FROM OLD.valid_until)
  THEN RAISE EXCEPTION 'INBOX_MEMBERSHIP_EPOCH_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.inbox_guard_membership_epoch() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER inbox_guard_membership_epoch BEFORE UPDATE ON public.whatsapp_channel_memberships
FOR EACH ROW EXECUTE FUNCTION public.inbox_guard_membership_epoch();

-- Identity and account scope must match the original row at association time.
-- No client-created customer row is thereby trusted for Meta window policy;
-- the ingress provenance/canonical claim must be added in SOF-89.
CREATE FUNCTION public.inbox_guard_message_membership()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.messages m
    JOIN public.conversations c ON c.id=m.conversation_id
    WHERE m.id=NEW.message_id AND m.conversation_id=NEW.conversation_id
      AND c.account_id=NEW.account_id AND m.provider=NEW.provider
      AND m.connection_id=NEW.connection_id
  ) THEN RAISE EXCEPTION 'INBOX_MESSAGE_SCOPE_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.inbox_guard_message_membership() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER inbox_guard_message_membership BEFORE INSERT ON public.inbox_message_memberships
FOR EACH ROW EXECUTE FUNCTION public.inbox_guard_message_membership();

-- Read-only, tenant-scoped reconciliation report. No writes, no automatic
-- assignment from mutable phone_identity, no legacy unread reset or message
-- content returned. Only the server may call it after account authorization.
CREATE FUNCTION public.inbox_legacy_inventory(p_account_id uuid)
RETURNS TABLE(source_messages bigint, associated_messages bigint, unresolved_messages bigint, parent_conversations bigint, legacy_unread bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
  WITH scoped AS (
    SELECT m.id, im.message_id AS associated
    FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id
    LEFT JOIN public.inbox_message_memberships im ON im.message_id=m.id AND im.account_id=c.account_id
    WHERE c.account_id=p_account_id
  )
  SELECT count(*),count(associated),count(*)-count(associated),
    (SELECT count(*) FROM public.conversations WHERE account_id=p_account_id),
    (SELECT coalesce(sum(unread_count),0)::bigint FROM public.conversations WHERE account_id=p_account_id)
  FROM scoped;
$$;
REVOKE ALL ON FUNCTION public.inbox_legacy_inventory(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_legacy_inventory(uuid) TO service_role;

COMMENT ON TABLE public.whatsapp_channels IS 'Shadow only. Verified own identity within tenant/provider; no implicit merging.';
COMMENT ON TABLE public.whatsapp_channel_memberships IS 'Verified historical membership epochs; service-managed. Enrollment and close-on-repair integration pending; never used to route before gate.';
COMMENT ON TABLE public.inbox_message_memberships IS 'Additive source association. Unlinked rows remain unresolved; no legacy row deletion or inferred routing.';
