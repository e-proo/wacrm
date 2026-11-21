-- SOF-89.01: durable canonical identity/observation intake foundation.
-- No legacy index replacement, no automatic fanout or provider dispatch.
-- Shared namespace requires explicit independently verified engine contract
-- and binding to immutable membership epoch. No enrollment is seeded.
CREATE TABLE public.inbox_native_namespace_proofs (
 account_id uuid NOT NULL, provider text NOT NULL, channel_id uuid NOT NULL,
 connection_id uuid NOT NULL, membership_id uuid PRIMARY KEY,
 namespace_key text NOT NULL CHECK(length(btrim(namespace_key)) BETWEEN 1 AND 128),
 evidence_ref text NOT NULL CHECK(length(btrim(evidence_ref)) BETWEEN 1 AND 200),
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(account_id,provider,channel_id,connection_id,membership_id)
 REFERENCES public.whatsapp_channel_memberships(account_id,provider,channel_id,connection_id,id)
);
CREATE TABLE public.inbox_canonical_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL, provider text NOT NULL, channel_id uuid NOT NULL,
 conversation_id uuid NOT NULL, namespace_key text NOT NULL,
 direction text NOT NULL CHECK(direction IN ('inbound','outbound')),
 native_message_id text NOT NULL CHECK(length(btrim(native_message_id)) BETWEEN 1 AND 512),
 origin_connection_id uuid NOT NULL, origin_membership_id uuid NOT NULL,
 -- Origin may not yet have been persisted in CRM. Do not guess it from legacy ID.
 source_message_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(account_id,provider,channel_id,namespace_key,direction,native_message_id),
 UNIQUE(account_id,provider,channel_id,id),
 FOREIGN KEY(account_id,conversation_id) REFERENCES public.conversations(account_id,id) ON DELETE CASCADE,
 FOREIGN KEY(account_id,provider,channel_id,origin_connection_id,origin_membership_id)
 REFERENCES public.whatsapp_channel_memberships(account_id,provider,channel_id,connection_id,id),
 FOREIGN KEY(source_message_id) REFERENCES public.messages(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX inbox_canonical_source_uidx ON public.inbox_canonical_messages(source_message_id) WHERE source_message_id IS NOT NULL;
CREATE TABLE public.inbox_message_connection_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL,provider text NOT NULL,channel_id uuid NOT NULL,
 connection_id uuid NOT NULL,membership_id uuid NOT NULL,
 canonical_id uuid NOT NULL, receipt_id uuid NOT NULL UNIQUE,
 native_message_id text NOT NULL CHECK(length(btrim(native_message_id)) BETWEEN 1 AND 512),
 direction text NOT NULL CHECK(direction IN ('inbound','outbound')),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(account_id,provider,channel_id,canonical_id)
 REFERENCES public.inbox_canonical_messages(account_id,provider,channel_id,id) ON DELETE CASCADE,
 FOREIGN KEY(account_id,provider,channel_id,connection_id,membership_id)
 REFERENCES public.whatsapp_channel_memberships(account_id,provider,channel_id,connection_id,id),
 FOREIGN KEY(receipt_id) REFERENCES public.whatsapp_webhook_event_receipts(id) ON DELETE RESTRICT,
 UNIQUE(canonical_id,connection_id,native_message_id,direction)
);
CREATE TABLE public.inbox_canonical_intake_review (
 receipt_id uuid PRIMARY KEY REFERENCES public.whatsapp_webhook_event_receipts(id) ON DELETE RESTRICT,
 account_id uuid NOT NULL,connection_id uuid NOT NULL,provider text NOT NULL,
 reason text NOT NULL CHECK(reason IN ('missing_verified_epoch','event_only_identity','namespace_unverified','peer_conflict','receipt_conflict','legacy_collision','outbound_echo_unproven')),
 -- Normalized content is server-only; never store signed headers, credentials or inline bytes.
 normalized_payload jsonb NOT NULL CHECK(jsonb_typeof(normalized_payload)='object' AND octet_length(normalized_payload::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(account_id,provider,connection_id) REFERENCES public.whatsapp_connections(account_id,provider,id)
);
-- Durable logical fanout reservation. The existing business pipeline will
-- consume this only after atomic source persistence; never reset a possibly
-- dispatched claim on timeout. No claim acquisition exposed to browser.
CREATE TABLE public.inbox_canonical_effects (
 canonical_id uuid PRIMARY KEY,
 account_id uuid NOT NULL,provider text NOT NULL,channel_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'awaiting_source' CHECK(state IN ('awaiting_source','pending','claimed','returned','review')),
 claim_token uuid,claimed_at timestamptz,returned_at timestamptz,
 FOREIGN KEY(account_id,provider,channel_id,canonical_id)
 REFERENCES public.inbox_canonical_messages(account_id,provider,channel_id,id) ON DELETE CASCADE
);
DO $acl$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['inbox_native_namespace_proofs','inbox_canonical_messages','inbox_message_connection_observations','inbox_canonical_intake_review','inbox_canonical_effects'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('GRANT SELECT,INSERT ON public.%I TO service_role',t);
  EXECUTE format('CREATE POLICY inbox_service_only ON public.%I FOR ALL TO service_role USING(true) WITH CHECK(true)',t);
 END LOOP;
END $acl$;
CREATE INDEX inbox_canonical_conversation_idx ON public.inbox_canonical_messages(account_id,conversation_id,channel_id,created_at DESC,id);
CREATE INDEX inbox_observations_canonical_idx ON public.inbox_message_connection_observations(account_id,canonical_id,observed_at);
CREATE INDEX inbox_intake_review_account_idx ON public.inbox_canonical_intake_review(account_id,created_at,receipt_id);

-- Admission is called only after signed webhook reservation. Match current lease,
-- tenant, exact route and epoch; a native ID is never an event ID fallback.
-- No receipt completion here: caller must finish the original webhook lease.
CREATE FUNCTION public.inbox_record_canonical_observation(
 p_account uuid,p_connection uuid,p_event text,p_token uuid,p_conversation uuid,
 p_session text,p_instance text,p_native_id text,p_native_proven boolean,p_direction text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE r public.whatsapp_webhook_event_receipts%ROWTYPE;c public.whatsapp_connections%ROWTYPE;
 ep public.whatsapp_channel_memberships%ROWTYPE; proof public.inbox_native_namespace_proofs%ROWTYPE;
 canon public.inbox_canonical_messages%ROWTYPE; prior public.inbox_message_connection_observations%ROWTYPE;
 reason text; new_id uuid; stored_review record;
BEGIN
 IF p_direction NOT IN ('inbound','outbound') OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>65536
 THEN RAISE EXCEPTION 'INBOX_BAD_OBSERVATION' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM public.whatsapp_webhook_event_receipts WHERE account_id=p_account AND connection_id=p_connection AND provider='openwa'
 AND provider_event_id=p_event AND processing_token=p_token AND processed_at IS NULL AND processing_started_at IS NOT NULL FOR UPDATE;
 IF NOT FOUND OR p_token IS NULL THEN RAISE EXCEPTION 'INBOX_SIGNED_RECEIPT_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT c FROM public.whatsapp_connections WHERE id=p_connection AND account_id=p_account AND provider='openwa' FOR SHARE;
 IF c.session_id IS DISTINCT FROM p_session OR c.instance_id IS DISTINCT FROM p_instance THEN RAISE EXCEPTION 'INBOX_ROUTE_CHANGED' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.conversations WHERE id=p_conversation AND account_id=p_account)
 THEN RAISE EXCEPTION 'INBOX_CONVERSATION_SCOPE' USING ERRCODE='23514'; END IF;
 SELECT * INTO stored_review FROM public.inbox_canonical_intake_review WHERE receipt_id=r.id AND account_id=p_account;
 IF FOUND THEN RETURN jsonb_build_object('state','review','reason',stored_review.reason); END IF;
 SELECT * INTO prior FROM public.inbox_message_connection_observations WHERE receipt_id=r.id AND account_id=p_account;
 IF FOUND THEN
  SELECT * INTO STRICT canon FROM public.inbox_canonical_messages WHERE id=prior.canonical_id AND account_id=p_account;
  IF prior.native_message_id IS DISTINCT FROM p_native_id OR prior.direction IS DISTINCT FROM p_direction OR canon.conversation_id IS DISTINCT FROM p_conversation THEN
   RAISE EXCEPTION 'INBOX_RECEIPT_PAYLOAD_CONFLICT' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('state','duplicate','canonicalId',prior.canonical_id);
 END IF;
 SELECT * INTO ep FROM public.whatsapp_channel_memberships WHERE account_id=p_account AND provider='openwa' AND connection_id=p_connection AND valid_until IS NULL FOR SHARE;
 IF NOT FOUND OR c.archived_at IS NOT NULL OR c.status NOT IN ('connected','ready') OR ep.session_snapshot IS DISTINCT FROM p_session OR ep.instance_snapshot IS DISTINCT FROM p_instance OR r.received_at<ep.valid_from
 THEN reason='missing_verified_epoch';
 ELSIF p_native_proven IS DISTINCT FROM true OR p_native_id IS NULL OR length(btrim(p_native_id)) NOT BETWEEN 1 AND 512
 THEN reason='event_only_identity';
 ELSE
  SELECT * INTO proof FROM public.inbox_native_namespace_proofs WHERE membership_id=ep.id AND account_id=p_account AND connection_id=p_connection AND channel_id=ep.channel_id AND provider='openwa';
  IF NOT FOUND THEN reason='namespace_unverified'; END IF;
 END IF;
 IF reason IS NULL THEN
  -- Unique canonical key serializes concurrent observations; peer mismatch
  -- is not accepted as duplicate. Direction is part of identity.
  INSERT INTO public.inbox_canonical_messages(account_id,provider,channel_id,conversation_id,namespace_key,direction,native_message_id,origin_connection_id,origin_membership_id)
  VALUES(p_account,'openwa',ep.channel_id,p_conversation,proof.namespace_key,p_direction,p_native_id,p_connection,ep.id)
  ON CONFLICT(account_id,provider,channel_id,namespace_key,direction,native_message_id) DO NOTHING RETURNING id INTO new_id;
  SELECT * INTO STRICT canon FROM public.inbox_canonical_messages WHERE account_id=p_account AND provider='openwa' AND channel_id=ep.channel_id
    AND namespace_key=proof.namespace_key AND direction=p_direction AND native_message_id=p_native_id FOR UPDATE;
  IF canon.conversation_id<>p_conversation THEN reason='peer_conflict';
  ELSE
   INSERT INTO public.inbox_message_connection_observations(account_id,provider,channel_id,connection_id,membership_id,canonical_id,receipt_id,native_message_id,direction)
   VALUES(p_account,'openwa',ep.channel_id,p_connection,ep.id,canon.id,r.id,p_native_id,p_direction)
   ON CONFLICT(canonical_id,connection_id,native_message_id,direction) DO NOTHING;
   INSERT INTO public.inbox_canonical_effects(canonical_id,account_id,provider,channel_id)
   VALUES(canon.id,p_account,'openwa',ep.channel_id) ON CONFLICT(canonical_id) DO NOTHING;
   RETURN jsonb_build_object('state',CASE WHEN new_id IS NULL THEN 'duplicate' ELSE 'reserved' END,'canonicalId',canon.id);
  END IF;
 END IF;
 INSERT INTO public.inbox_canonical_intake_review(receipt_id,account_id,connection_id,provider,reason,normalized_payload)
 VALUES(r.id,p_account,p_connection,'openwa',reason,p_payload);
 RETURN jsonb_build_object('state','review','reason',reason);
END $$;
REVOKE ALL ON FUNCTION public.inbox_record_canonical_observation(uuid,uuid,text,uuid,uuid,text,text,text,boolean,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_record_canonical_observation(uuid,uuid,text,uuid,uuid,text,text,text,boolean,text,jsonb) TO service_role;
COMMENT ON TABLE public.inbox_native_namespace_proofs IS 'No automatic proof from same phone or native ID syntax. Engine-contract verification and approved enrollment required; no proof rows seeded.';
COMMENT ON TABLE public.inbox_canonical_effects IS 'Reservation only; atomic source persistence and integration with existing effects pipeline required before any activation.';
