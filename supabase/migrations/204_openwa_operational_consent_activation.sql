-- OW14-W07-02: inert, tenant-scoped production opt-in registry and audit.
-- No policy is approved/seeded, no session is enabled, no WhatsApp send,
-- no TEST Pilot override, and no Production access is granted by this migration.
-- W07-03 must enforce actor identity in its authenticated Next.js route;
-- W07-04 must enforce the policy at the shared outbound dispatch boundary.

-- A single, approved current version will be published only by a separate
-- Product/Legal-authorized additive migration. service_role is read-only here.
CREATE TABLE public.whatsapp_openwa_policy_versions (
  version text PRIMARY KEY CHECK (length(version) BETWEEN 8 AND 120),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  approved_at timestamptz NOT NULL,
  approval_ref text NOT NULL CHECK (length(approval_ref) BETWEEN 8 AND 200),
  is_current boolean NOT NULL DEFAULT false,
  CONSTRAINT openwa_policy_version_digest_unique UNIQUE (version,digest)
);
CREATE UNIQUE INDEX openwa_policy_one_current_idx
  ON public.whatsapp_openwa_policy_versions(is_current) WHERE is_current;

-- Any linked connection remains unapproved, including pre-existing sessions.
CREATE UNIQUE INDEX whatsapp_connections_account_id_id_w07_idx
  ON public.whatsapp_connections(account_id,id);

CREATE TABLE public.whatsapp_openwa_consent_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  request_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('accept','revoke')),
  policy_version text NOT NULL,
  policy_digest text NOT NULL,
  prior_revision bigint NOT NULL CHECK (prior_revision >= 0),
  revision bigint NOT NULL CHECK (revision = prior_revision + 1),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT openwa_consent_audit_policy_fk FOREIGN KEY (policy_version,policy_digest)
    REFERENCES public.whatsapp_openwa_policy_versions(version,digest),
  CONSTRAINT openwa_consent_audit_account_id_unique UNIQUE (account_id,id),
  CONSTRAINT openwa_consent_audit_request_unique UNIQUE (account_id,request_id),
  CONSTRAINT openwa_consent_audit_revision_unique UNIQUE (account_id,revision)
);
CREATE INDEX openwa_consent_audit_scope_idx
  ON public.whatsapp_openwa_consent_audit(account_id,recorded_at DESC);

CREATE TABLE public.whatsapp_openwa_consent_state (
  account_id uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('accepted','revoked')),
  policy_version text NOT NULL,
  policy_digest text NOT NULL,
  accepted_event_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 1),
  updated_by uuid NOT NULL REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT openwa_consent_state_policy_fk FOREIGN KEY (policy_version,policy_digest)
    REFERENCES public.whatsapp_openwa_policy_versions(version,digest),
  CONSTRAINT openwa_consent_state_event_fk FOREIGN KEY (account_id,accepted_event_id)
    REFERENCES public.whatsapp_openwa_consent_audit(account_id,id)
);

CREATE TABLE public.whatsapp_openwa_activation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  request_id uuid NOT NULL,
  previous_status text NOT NULL CHECK (previous_status IN ('disabled','enabled','suspended')),
  new_status text NOT NULL CHECK (new_status IN ('disabled','enabled','suspended')),
  consent_event_id uuid,
  prior_revision bigint NOT NULL CHECK (prior_revision >= 0),
  revision bigint NOT NULL CHECK (revision = prior_revision + 1),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT openwa_activation_audit_account_connection_fk
    FOREIGN KEY (account_id,connection_id) REFERENCES public.whatsapp_connections(account_id,id),
  CONSTRAINT openwa_activation_audit_consent_fk FOREIGN KEY (account_id,consent_event_id)
    REFERENCES public.whatsapp_openwa_consent_audit(account_id,id),
  CONSTRAINT openwa_activation_audit_status_shape CHECK
    ((new_status = 'enabled' AND consent_event_id IS NOT NULL)
      OR (new_status <> 'enabled' AND consent_event_id IS NULL)),
  CONSTRAINT openwa_activation_audit_request_unique UNIQUE (account_id,request_id),
  CONSTRAINT openwa_activation_audit_revision_unique UNIQUE (account_id,connection_id,revision)
);
CREATE INDEX openwa_activation_audit_scope_idx
  ON public.whatsapp_openwa_activation_audit(account_id,connection_id,recorded_at DESC);

CREATE TABLE public.whatsapp_openwa_activation_state (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'disabled'
    CHECK (status IN ('disabled','enabled','suspended')),
  consent_event_id uuid,
  revision bigint NOT NULL CHECK (revision >= 1),
  updated_by uuid NOT NULL REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id,connection_id),
  CONSTRAINT openwa_activation_state_connection_fk FOREIGN KEY (account_id,connection_id)
    REFERENCES public.whatsapp_connections(account_id,id),
  CONSTRAINT openwa_activation_state_consent_fk FOREIGN KEY (account_id,consent_event_id)
    REFERENCES public.whatsapp_openwa_consent_audit(account_id,id),
  CONSTRAINT openwa_activation_state_shape CHECK
    ((status = 'enabled' AND consent_event_id IS NOT NULL)
      OR (status <> 'enabled' AND consent_event_id IS NULL))
);

-- Data API clients have NO direct table privileges even if authenticated.
-- RLS is enabled for every public table as a defense-in-depth boundary.
ALTER TABLE public.whatsapp_openwa_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_openwa_consent_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_openwa_consent_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_openwa_activation_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_openwa_activation_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.whatsapp_openwa_policy_versions,
  public.whatsapp_openwa_consent_audit,
  public.whatsapp_openwa_consent_state,
  public.whatsapp_openwa_activation_audit,
  public.whatsapp_openwa_activation_state
  FROM PUBLIC,anon,authenticated,service_role;

-- NOTE-001 ACL hardening means service_role does not have broad SELECT on
-- profiles. Grant ONLY the three membership columns needed by the invoker
-- RPCs, never a whole-table read or any client privilege.
GRANT SELECT (user_id,account_id,account_role) ON public.profiles TO service_role;
-- A connection status check is read-only; never grant W07 UPDATE rights on
-- existing WhatsApp connection rows just to take a FOR UPDATE lock.
GRANT SELECT (id,account_id,provider,archived_at,status,session_id)
  ON public.whatsapp_connections TO service_role;

GRANT SELECT ON public.whatsapp_openwa_policy_versions TO service_role;
GRANT SELECT,INSERT ON public.whatsapp_openwa_consent_audit,
  public.whatsapp_openwa_activation_audit TO service_role;
GRANT SELECT,INSERT,UPDATE ON public.whatsapp_openwa_consent_state,
  public.whatsapp_openwa_activation_state TO service_role;

CREATE POLICY openwa_policy_registry_read ON public.whatsapp_openwa_policy_versions
  FOR SELECT TO service_role USING (true);
CREATE POLICY openwa_consent_audit_read ON public.whatsapp_openwa_consent_audit
  FOR SELECT TO service_role USING (true);
CREATE POLICY openwa_consent_audit_append ON public.whatsapp_openwa_consent_audit
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY openwa_consent_state_read ON public.whatsapp_openwa_consent_state
  FOR SELECT TO service_role USING (true);
CREATE POLICY openwa_consent_state_insert ON public.whatsapp_openwa_consent_state
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY openwa_consent_state_update ON public.whatsapp_openwa_consent_state
  FOR UPDATE TO service_role USING (true) WITH CHECK (true);
CREATE POLICY openwa_activation_audit_read ON public.whatsapp_openwa_activation_audit
  FOR SELECT TO service_role USING (true);
CREATE POLICY openwa_activation_audit_append ON public.whatsapp_openwa_activation_audit
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY openwa_activation_state_read ON public.whatsapp_openwa_activation_state
  FOR SELECT TO service_role USING (true);
CREATE POLICY openwa_activation_state_insert ON public.whatsapp_openwa_activation_state
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY openwa_activation_state_update ON public.whatsapp_openwa_activation_state
  FOR UPDATE TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.whatsapp_openwa_policy_versions IS
  'Owner-approved policy registry; initially EMPTY and unreadable/writable by clients. Never seed a draft policy or activate Production from TEST Pilot.';
COMMENT ON TABLE public.whatsapp_openwa_consent_audit IS
  'Append-only actor/version/revision trail; no recipient, QR, message, gateway key or session ID. service_role cannot UPDATE/DELETE/TRUNCATE.';
COMMENT ON TABLE public.whatsapp_openwa_activation_audit IS
  'Append-only per-connection actor/revision trail; does not establish a WhatsApp delivery outcome or authorize a resend.';
COMMENT ON TABLE public.whatsapp_openwa_consent_state IS
  'Last account-owner decision. Revocation or new acceptance invalidates previously bound per-connection consent event IDs.';
COMMENT ON TABLE public.whatsapp_openwa_activation_state IS
  'Server-side requested connection status only; actual send still requires live consent, feature gate, pause/circuit, recipient policy and W07-04 enforcement.';

-- Atomic service-role-only consent mutation. Service-role callers MUST pass
-- the authenticated caller's user id from getUser(), never a client-provided
-- actor. The function independently verifies current owner membership.
CREATE FUNCTION public.set_openwa_operational_consent(
  p_account_id uuid, p_actor uuid, p_action text, p_policy_version text,
  p_policy_digest text, p_expected_revision bigint, p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE
  v_current public.whatsapp_openwa_consent_state%ROWTYPE;
  v_existing public.whatsapp_openwa_consent_audit%ROWTYPE;
  v_revision bigint;
  v_version text;
  v_digest text;
  v_event_id uuid;
  v_status text;
BEGIN
  IF p_account_id IS NULL OR p_actor IS NULL OR p_action NOT IN ('accept','revoke')
     OR p_action IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0
     OR p_request_id IS NULL OR
     (p_action='accept' AND (p_policy_version IS NULL OR p_policy_digest IS NULL
       OR length(p_policy_version) NOT BETWEEN 8 AND 120
       OR p_policy_digest !~ '^[0-9a-f]{64}$'))
     OR (p_action='revoke' AND (p_policy_version IS NOT NULL OR p_policy_digest IS NOT NULL))
  THEN RETURN pg_catalog.jsonb_build_object('updated',false,'reason','invalid_request'); END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles p
    WHERE p.account_id=p_account_id AND p.user_id=p_actor
      AND p.account_role::text='owner')
  THEN RETURN pg_catalog.jsonb_build_object('updated',false,'reason','actor_forbidden'); END IF;

  -- Serializes ALL policy changes and activation decisions for this account.
  -- Narrow serialization: never require service_role UPDATE rights on accounts.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('w07-operational:'||p_account_id::text));

  SELECT * INTO v_existing FROM public.whatsapp_openwa_consent_audit
    WHERE account_id=p_account_id AND request_id=p_request_id;
  IF FOUND THEN
    IF v_existing.actor_id=p_actor AND v_existing.action=p_action
      AND (p_action='revoke'
        OR (v_existing.policy_version=p_policy_version AND
            v_existing.policy_digest=p_policy_digest))
    THEN RETURN pg_catalog.jsonb_build_object('updated',false,'idempotent',true,
      'revision',v_existing.revision,'status',
      CASE WHEN v_existing.action='accept' THEN 'accepted' ELSE 'revoked' END);
    END IF;
    RETURN pg_catalog.jsonb_build_object('updated',false,'reason','request_conflict');
  END IF;

  SELECT * INTO v_current FROM public.whatsapp_openwa_consent_state
    WHERE account_id=p_account_id FOR UPDATE;
  v_revision := COALESCE(v_current.revision,0);
  IF p_expected_revision<>v_revision THEN
    RETURN pg_catalog.jsonb_build_object('updated',false,'reason','revision_conflict',
      'revision',v_revision);
  END IF;

  IF p_action='accept' THEN
    IF NOT EXISTS (SELECT 1 FROM public.whatsapp_openwa_policy_versions v
      WHERE v.version=p_policy_version AND v.digest=p_policy_digest AND v.is_current)
    THEN RETURN pg_catalog.jsonb_build_object('updated',false,'reason','policy_not_approved');
    END IF;
    IF v_current.status='accepted' AND v_current.policy_version=p_policy_version
       AND v_current.policy_digest=p_policy_digest THEN
      RETURN pg_catalog.jsonb_build_object('updated',false,'reason','already_accepted',
        'revision',v_revision);
    END IF;
    v_version:=p_policy_version;
    v_digest:=p_policy_digest;
    v_status:='accepted';
  ELSE
    IF v_current.status IS DISTINCT FROM 'accepted' THEN
      RETURN pg_catalog.jsonb_build_object('updated',false,'reason','consent_not_active');
    END IF;
    v_version:=v_current.policy_version;
    v_digest:=v_current.policy_digest;
    v_status:='revoked';
  END IF;

  INSERT INTO public.whatsapp_openwa_consent_audit
    (account_id,actor_id,request_id,action,policy_version,policy_digest,
     prior_revision,revision)
  VALUES (p_account_id,p_actor,p_request_id,p_action,v_version,v_digest,
    v_revision,v_revision+1)
  RETURNING id INTO v_event_id;

  INSERT INTO public.whatsapp_openwa_consent_state AS current_state
    (account_id,status,policy_version,policy_digest,accepted_event_id,
     revision,updated_by,updated_at)
  VALUES (p_account_id,v_status,v_version,v_digest,
    CASE WHEN p_action='accept' THEN v_event_id ELSE v_current.accepted_event_id END,
    v_revision+1,p_actor,pg_catalog.clock_timestamp())
  ON CONFLICT (account_id) DO UPDATE SET
    status=excluded.status,policy_version=excluded.policy_version,
    policy_digest=excluded.policy_digest,accepted_event_id=excluded.accepted_event_id,
    revision=excluded.revision,updated_by=excluded.updated_by,updated_at=excluded.updated_at;

  RETURN pg_catalog.jsonb_build_object('updated',true,'status',v_status,
    'revision',v_revision+1);
END $fn$;
REVOKE ALL ON FUNCTION public.set_openwa_operational_consent(uuid,uuid,text,text,text,bigint,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.set_openwa_operational_consent(uuid,uuid,text,text,text,bigint,uuid)
  TO service_role;

-- Transactionally authorized activation; never triggers a send, schedule,
-- pilot mode change, session start, Meta routing or provider fallback.
CREATE FUNCTION public.set_openwa_operational_activation(
  p_account_id uuid, p_connection_id uuid, p_actor uuid, p_status text,
  p_expected_revision bigint, p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $fn$
DECLARE
  v_connection record;
  v_current public.whatsapp_openwa_activation_state%ROWTYPE;
  v_existing public.whatsapp_openwa_activation_audit%ROWTYPE;
  v_consent public.whatsapp_openwa_consent_state%ROWTYPE;
  v_revision bigint;
  v_bound_consent uuid;
BEGIN
  IF p_account_id IS NULL OR p_connection_id IS NULL OR p_actor IS NULL
    OR p_status NOT IN ('enabled','disabled','suspended') OR p_status IS NULL
    OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_request_id IS NULL
  THEN RETURN pg_catalog.jsonb_build_object('updated',false,'reason','invalid_request'); END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles p
    WHERE p.user_id=p_actor AND p.account_id=p_account_id
      AND p.account_role::text IN ('owner','admin'))
  THEN RETURN pg_catalog.jsonb_build_object('updated',false,'reason','actor_forbidden'); END IF;

  -- Match lock order of set_openwa_operational_consent: account first.
  -- Same account-level lock as consent; no broad UPDATE grant on accounts.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('w07-operational:'||p_account_id::text));

  SELECT c.status,c.session_id INTO v_connection
    FROM public.whatsapp_connections c
    WHERE c.id=p_connection_id AND c.account_id=p_account_id
      AND c.provider='openwa' AND c.archived_at IS NULL;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('updated',false,'reason','connection_scope_mismatch');
  END IF;

  SELECT * INTO v_existing FROM public.whatsapp_openwa_activation_audit
    WHERE account_id=p_account_id AND request_id=p_request_id;
  IF FOUND THEN
    IF v_existing.actor_id=p_actor AND v_existing.connection_id=p_connection_id
       AND v_existing.new_status=p_status
    THEN RETURN pg_catalog.jsonb_build_object('updated',false,'idempotent',true,
      'revision',v_existing.revision,'status',v_existing.new_status);
    END IF;
    RETURN pg_catalog.jsonb_build_object('updated',false,'reason','request_conflict');
  END IF;

  SELECT * INTO v_current FROM public.whatsapp_openwa_activation_state
    WHERE account_id=p_account_id AND connection_id=p_connection_id FOR UPDATE;
  v_revision:=COALESCE(v_current.revision,0);
  IF p_expected_revision<>v_revision THEN
    RETURN pg_catalog.jsonb_build_object('updated',false,'reason','revision_conflict',
      'revision',v_revision);
  END IF;

  v_bound_consent:=NULL;
  IF p_status='enabled' THEN
    IF v_connection.status NOT IN ('ready','connected') OR v_connection.session_id IS NULL THEN
      RETURN pg_catalog.jsonb_build_object('updated',false,'reason','session_not_ready');
    END IF;
    SELECT * INTO v_consent FROM public.whatsapp_openwa_consent_state
      WHERE account_id=p_account_id AND status='accepted';
    IF NOT FOUND OR v_consent.accepted_event_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM public.whatsapp_openwa_policy_versions v
         JOIN public.whatsapp_openwa_consent_audit e
           ON e.id=v_consent.accepted_event_id AND e.account_id=p_account_id
           AND e.action='accept'
         WHERE v.version=v_consent.policy_version AND v.digest=v_consent.policy_digest
           AND v.is_current AND e.policy_version=v.version AND e.policy_digest=v.digest)
    THEN RETURN pg_catalog.jsonb_build_object('updated',false,'reason','consent_required');
    END IF;
    v_bound_consent:=v_consent.accepted_event_id;
  END IF;

  IF v_current.status=p_status AND
     v_current.consent_event_id IS NOT DISTINCT FROM v_bound_consent THEN
    RETURN pg_catalog.jsonb_build_object('updated',false,'reason','already_current',
      'revision',v_revision);
  END IF;
  IF v_revision=0 AND p_status='disabled' THEN
    RETURN pg_catalog.jsonb_build_object('updated',false,'reason','already_disabled',
      'revision',0);
  END IF;

  INSERT INTO public.whatsapp_openwa_activation_audit
    (account_id,connection_id,actor_id,request_id,previous_status,new_status,
     consent_event_id,prior_revision,revision)
  VALUES (p_account_id,p_connection_id,p_actor,p_request_id,
    COALESCE(v_current.status,'disabled'),p_status,v_bound_consent,
    v_revision,v_revision+1);

  INSERT INTO public.whatsapp_openwa_activation_state AS current_activation
    (account_id,connection_id,status,consent_event_id,revision,updated_by,updated_at)
  VALUES (p_account_id,p_connection_id,p_status,v_bound_consent,
    v_revision+1,p_actor,pg_catalog.clock_timestamp())
  ON CONFLICT (account_id,connection_id) DO UPDATE SET
    status=excluded.status,consent_event_id=excluded.consent_event_id,
    revision=excluded.revision,updated_by=excluded.updated_by,updated_at=excluded.updated_at;

  RETURN pg_catalog.jsonb_build_object('updated',true,'status',p_status,
    'revision',v_revision+1);
END $fn$;
REVOKE ALL ON FUNCTION public.set_openwa_operational_activation(uuid,uuid,uuid,text,bigint,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.set_openwa_operational_activation(uuid,uuid,uuid,text,bigint,uuid)
  TO service_role;
