-- INBOX-1 / SOF-76: verified enrollment, route invalidation and evidence-only backfill.
-- No provider activation; current webhook/send paths remain unchanged.
CREATE FUNCTION public.inbox_enroll_verified_channel(
 p_account uuid,p_actor uuid,p_connection uuid,p_provider text,p_identity text,
 p_session text,p_instance text,p_connection_version timestamptz,p_credential_version timestamptz,
 p_checked_at timestamptz,p_evidence_ref text,p_primary boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE c public.whatsapp_connections%ROWTYPE; ch uuid; ep public.whatsapp_channel_memberships%ROWTYPE;
 cv timestamptz; v_now timestamptz; config_number text; k text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=p_actor AND account_id=p_account AND account_role IN ('owner','admin')) THEN
  RAISE EXCEPTION 'INBOX_ADMIN_REQUIRED' USING ERRCODE='42501';
 END IF;
 SELECT * INTO c FROM public.whatsapp_connections WHERE account_id=p_account AND id=p_connection AND provider=p_provider FOR UPDATE;
 IF NOT FOUND OR c.archived_at IS NOT NULL OR c.status NOT IN ('ready','connected')
   OR c.updated_at IS DISTINCT FROM p_connection_version THEN
  RAISE EXCEPTION 'INBOX_STALE_OR_UNAVAILABLE_ROUTE' USING ERRCODE='23514';
 END IF;
 IF p_checked_at IS NULL OR p_checked_at>clock_timestamp()+interval '10 seconds' OR p_checked_at<clock_timestamp()-interval '2 minutes' THEN
  RAISE EXCEPTION 'INBOX_STALE_EVIDENCE' USING ERRCODE='23514';
 END IF;
 IF p_provider='openwa' THEN
  SELECT updated_at INTO cv FROM public.whatsapp_connection_credentials WHERE account_id=p_account AND connection_id=p_connection AND provider='openwa' FOR UPDATE;
  IF NOT FOUND OR cv IS DISTINCT FROM p_credential_version OR p_session IS NULL OR c.session_id IS DISTINCT FROM p_session
    OR c.instance_id IS DISTINCT FROM p_instance OR p_identity IS NULL OR p_identity !~ '^[1-9][0-9]{6,14}$'
    OR regexp_replace(coalesce(c.phone_identity,''),'^\+','') IS DISTINCT FROM p_identity THEN
   RAISE EXCEPTION 'INBOX_OPENWA_IDENTITY_NOT_VERIFIED' USING ERRCODE='23514';
  END IF;
  k='e164:'||p_identity;
 ELSIF p_provider='meta_cloud' THEN
  SELECT updated_at,phone_number_id INTO cv,config_number FROM public.whatsapp_config WHERE account_id=p_account FOR UPDATE;
  IF NOT FOUND OR cv IS DISTINCT FROM p_credential_version OR p_session IS NOT NULL OR p_instance IS NOT NULL
    OR p_identity IS NULL OR p_identity !~ '^[0-9]{1,32}$' OR config_number IS DISTINCT FROM p_identity OR c.provider_external_id IS DISTINCT FROM p_identity THEN
   RAISE EXCEPTION 'INBOX_META_IDENTITY_NOT_VERIFIED' USING ERRCODE='23514';
  END IF;
  k='phone_number_id:'||p_identity;
 ELSE RAISE EXCEPTION 'INBOX_UNSUPPORTED_PROVIDER' USING ERRCODE='23514';
 END IF;
 v_now=clock_timestamp();
 INSERT INTO public.whatsapp_channels(account_id,provider,identity_key,display_name)
 VALUES(p_account,p_provider,k,nullif(btrim(c.display_name),''))
 ON CONFLICT(account_id,provider,identity_key) DO NOTHING;
 SELECT id INTO STRICT ch FROM public.whatsapp_channels WHERE account_id=p_account AND provider=p_provider AND identity_key=k FOR NO KEY UPDATE;
 SELECT * INTO ep FROM public.whatsapp_channel_memberships WHERE account_id=p_account AND connection_id=p_connection AND valid_until IS NULL FOR UPDATE;
 IF FOUND AND ep.channel_id<>ch THEN
  UPDATE public.whatsapp_channel_memberships SET valid_until=greatest(v_now,valid_from),is_primary=false WHERE id=ep.id;
  ep.id=NULL;
 END IF;
 IF ep.id IS NULL THEN
  INSERT INTO public.whatsapp_channel_memberships(account_id,provider,channel_id,connection_id,session_snapshot,instance_snapshot,external_snapshot,evidence_kind,evidence_ref,verified_at,valid_from)
  VALUES(p_account,p_provider,ch,p_connection,p_session,p_instance,CASE WHEN p_provider='meta_cloud' THEN p_identity END,
    CASE WHEN p_provider='openwa' THEN 'authenticated_openwa_status' ELSE 'verified_meta_phone_number' END,p_evidence_ref,v_now,v_now)
  RETURNING * INTO ep;
 END IF;
 -- Explicit administrator choice only: no automatic primary promotion.
 IF p_primary THEN
  UPDATE public.whatsapp_channel_memberships SET is_primary=false WHERE account_id=p_account AND channel_id=ch AND valid_until IS NULL AND is_primary AND id<>ep.id;
  UPDATE public.whatsapp_channel_memberships SET is_primary=true WHERE id=ep.id;
 END IF;
 RETURN jsonb_build_object('channel_id',ch,'membership_id',ep.id,'primary',p_primary OR ep.is_primary);
END $$;
REVOKE ALL ON FUNCTION public.inbox_enroll_verified_channel(uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_enroll_verified_channel(uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,text,boolean) TO service_role;

-- Private, tightly scoped trigger closes only the affected active epoch. This
-- is necessary even for legacy authenticated settings writes, which cannot
-- themselves access the server-only membership table. No provider operations.
CREATE FUNCTION wacrm_internal.inbox_invalidate_route()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='whatsapp_connections' THEN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.instance_id IS DISTINCT FROM OLD.instance_id
    OR NEW.phone_identity IS DISTINCT FROM OLD.phone_identity OR NEW.provider_external_id IS DISTINCT FROM OLD.provider_external_id
    OR NEW.archived_at IS DISTINCT FROM OLD.archived_at OR (OLD.status IN ('connected','ready') AND NEW.status NOT IN ('connected','ready')) THEN
   UPDATE public.whatsapp_channel_memberships SET valid_until=greatest(clock_timestamp(),valid_from),is_primary=false
     WHERE account_id=OLD.account_id AND connection_id=OLD.id AND valid_until IS NULL;
  END IF;
 ELSIF TG_TABLE_NAME='whatsapp_connection_credentials' THEN
  IF TG_OP='DELETE' THEN
   UPDATE public.whatsapp_channel_memberships SET valid_until=greatest(clock_timestamp(),valid_from),is_primary=false
     WHERE account_id=OLD.account_id AND connection_id=OLD.connection_id AND valid_until IS NULL;
   RETURN OLD;
  END IF;
  IF NEW.base_url IS DISTINCT FROM OLD.base_url OR NEW.api_key_encrypted IS DISTINCT FROM OLD.api_key_encrypted
     OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.webhook_secret_encrypted IS DISTINCT FROM OLD.webhook_secret_encrypted THEN
   UPDATE public.whatsapp_channel_memberships SET valid_until=greatest(clock_timestamp(),valid_from),is_primary=false
     WHERE account_id=OLD.account_id AND connection_id=OLD.connection_id AND valid_until IS NULL;
  END IF;
 ELSIF TG_TABLE_NAME='whatsapp_config' THEN
  IF TG_OP='DELETE' THEN
   UPDATE public.whatsapp_channel_memberships SET valid_until=greatest(clock_timestamp(),valid_from),is_primary=false
     WHERE account_id=OLD.account_id AND provider='meta_cloud' AND valid_until IS NULL; RETURN OLD;
  END IF;
  IF NEW.phone_number_id IS DISTINCT FROM OLD.phone_number_id OR NEW.access_token IS DISTINCT FROM OLD.access_token
    OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.status IS DISTINCT FROM OLD.status THEN
   UPDATE public.whatsapp_channel_memberships SET valid_until=greatest(clock_timestamp(),valid_from),is_primary=false
    WHERE account_id=OLD.account_id AND provider='meta_cloud' AND valid_until IS NULL;
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_invalidate_route() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER inbox_connection_epoch_invalidate AFTER UPDATE ON public.whatsapp_connections
 FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_invalidate_route();
CREATE TRIGGER inbox_credential_epoch_invalidate AFTER UPDATE OR DELETE ON public.whatsapp_connection_credentials
 FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_invalidate_route();
CREATE TRIGGER inbox_meta_epoch_invalidate AFTER UPDATE OR DELETE ON public.whatsapp_config
 FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_invalidate_route();

-- Explicit verified evidence only, no inferred historical assignment.
-- This ledger is populated by a future trusted native-proof collector, never
-- a browser, phone string, timestamp heuristic or current status check alone.
CREATE TABLE public.inbox_verified_message_evidence (
 message_id uuid PRIMARY KEY,
 account_id uuid NOT NULL, conversation_id uuid NOT NULL, provider text NOT NULL,
 channel_id uuid NOT NULL, connection_id uuid NOT NULL,membership_id uuid NOT NULL,
 native_message_id text NOT NULL CHECK(length(btrim(native_message_id)) BETWEEN 1 AND 512),
 observed_at timestamptz NOT NULL,
 evidence_ref text NOT NULL CHECK(length(btrim(evidence_ref)) BETWEEN 1 AND 200),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(conversation_id,message_id) REFERENCES public.messages(conversation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(account_id,conversation_id) REFERENCES public.conversations(account_id,id) ON DELETE CASCADE,
 FOREIGN KEY(account_id,provider,channel_id,connection_id,membership_id) REFERENCES public.whatsapp_channel_memberships(account_id,provider,channel_id,connection_id,id)
);
ALTER TABLE public.inbox_verified_message_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.inbox_verified_message_evidence FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.inbox_verified_message_evidence TO service_role;
CREATE POLICY inbox_service_only ON public.inbox_verified_message_evidence FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE INDEX inbox_verified_evidence_account_page ON public.inbox_verified_message_evidence(account_id,message_id);

CREATE FUNCTION public.inbox_backfill_verified_messages(p_account uuid,p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE e record; t public.inbox_threads%ROWTYPE; n integer:=0; seq bigint; src public.messages%ROWTYPE;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'INBOX_BATCH_LIMIT' USING ERRCODE='22023'; END IF;
 -- Serialize per account, also lock the target thread for per-thread sequence.
 PERFORM pg_advisory_xact_lock(hashtextextended('inbox-backfill:'||p_account::text,0));
 FOR e IN SELECT v.* FROM public.inbox_verified_message_evidence v
 JOIN public.whatsapp_channel_memberships ep ON ep.id=v.membership_id AND ep.account_id=v.account_id
 WHERE v.account_id=p_account AND v.observed_at>=ep.valid_from AND (ep.valid_until IS NULL OR v.observed_at<ep.valid_until)
 AND NOT EXISTS(SELECT 1 FROM public.inbox_message_memberships im WHERE im.message_id=v.message_id)
 ORDER BY v.message_id LIMIT p_limit
 LOOP
  SELECT * INTO src FROM public.messages WHERE id=e.message_id AND conversation_id=e.conversation_id
    AND provider=e.provider AND connection_id=e.connection_id AND provider_message_id=e.native_message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_HISTORICAL_EVIDENCE_MISMATCH' USING ERRCODE='23514'; END IF;
  INSERT INTO public.inbox_threads(account_id,conversation_id,channel_id,provider)
    VALUES(e.account_id,e.conversation_id,e.channel_id,e.provider) ON CONFLICT(account_id,conversation_id,channel_id) DO NOTHING;
  SELECT * INTO STRICT t FROM public.inbox_threads WHERE account_id=e.account_id AND conversation_id=e.conversation_id AND channel_id=e.channel_id FOR UPDATE;
  seq=t.ingest_highwater+1;
  INSERT INTO public.inbox_message_memberships(message_id,account_id,conversation_id,channel_id,thread_id,provider,connection_id,membership_id,evidence_kind,evidence_ref,ingest_sequence)
   VALUES(e.message_id,e.account_id,e.conversation_id,e.channel_id,t.id,e.provider,e.connection_id,e.membership_id,'verified_historical_epoch',e.evidence_ref,seq);
  UPDATE public.inbox_threads SET ingest_highwater=seq,
   last_message_id=CASE WHEN t.last_message_at IS NULL OR (src.created_at,src.id)>(t.last_message_at,t.last_message_id) THEN src.id ELSE t.last_message_id END,
   last_message_at=CASE WHEN t.last_message_at IS NULL OR (src.created_at,src.id)>(t.last_message_at,t.last_message_id) THEN src.created_at ELSE t.last_message_at END
   WHERE id=t.id AND account_id=p_account;
  -- No retrospective trusted window, unread increment, bot, automation or dispatch.
  n=n+1;
 END LOOP;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.inbox_backfill_verified_messages(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_backfill_verified_messages(uuid,integer) TO service_role;

-- Capture legacy unread as a separate unresolved bucket. Idempotent capture,
-- not a live read watermark. Must re-snapshot before eventual cutover.
CREATE FUNCTION public.inbox_capture_legacy_unread(p_account uuid)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE n integer;
BEGIN
 INSERT INTO public.inbox_legacy_unread(account_id,conversation_id,unread_count)
 SELECT account_id,id,coalesce(unread_count,0) FROM public.conversations WHERE account_id=p_account AND coalesce(unread_count,0)>0
 ON CONFLICT(account_id,conversation_id) DO NOTHING;
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.inbox_capture_legacy_unread(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_capture_legacy_unread(uuid) TO service_role;

COMMENT ON TABLE public.inbox_verified_message_evidence IS 'Server-only native proof ledger; absence/mismatch stays unresolved. No evidence fabricated from mutable registry.';
