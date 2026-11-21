-- SOF-76: append-only verification audit and shadow projection maintenance.
-- No activation, dispatch, or inferred historical ownership.
CREATE TABLE public.inbox_integrity_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
 actor_id uuid, -- authenticated actor when known; NULL = system/service action
 event_type text NOT NULL CHECK(event_type IN (
 'identity_enrolled','identity_reverified','primary_selected','membership_closed','primary_changed',
 'message_reparented','message_identity_invalidated','message_deleted','contact_reparented','legacy_parent_deleted')),
 channel_id uuid, connection_id uuid, membership_id uuid, message_id uuid,
 conversation_id uuid, previous_conversation_id uuid,
 evidence_ref text CHECK(evidence_ref IS NULL OR length(btrim(evidence_ref)) BETWEEN 1 AND 200),
 happened_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.inbox_integrity_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbox_integrity_audit FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.inbox_integrity_audit TO service_role;
CREATE POLICY inbox_audit_service_only ON public.inbox_integrity_audit FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE INDEX inbox_integrity_audit_account_page ON public.inbox_integrity_audit(account_id,happened_at DESC,id DESC);
COMMENT ON TABLE public.inbox_integrity_audit IS 'Append-only restricted audit, IDs/evidence references only; no phone, content, credentials or provider payload.';

-- INBOX-1 / SOF-76: verified enrollment, route invalidation and evidence-only backfill.
-- No provider activation; current webhook/send paths remain unchanged.
CREATE OR REPLACE FUNCTION public.inbox_enroll_verified_channel(
 p_account uuid,p_actor uuid,p_connection uuid,p_provider text,p_identity text,
 p_session text,p_instance text,p_connection_version timestamptz,p_credential_version timestamptz,
 p_checked_at timestamptz,p_evidence_ref text,p_primary boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE c public.whatsapp_connections%ROWTYPE; ch uuid; ep public.whatsapp_channel_memberships%ROWTYPE;
 cv timestamptz; v_now timestamptz; config_number text; k text; new_epoch boolean:=false;
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
  new_epoch:=true;
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
 INSERT INTO public.inbox_integrity_audit(account_id,actor_id,event_type,channel_id,connection_id,membership_id,evidence_ref)
 VALUES(p_account,p_actor,CASE WHEN new_epoch THEN 'identity_enrolled' ELSE 'identity_reverified' END,ch,p_connection,ep.id,p_evidence_ref);
 IF p_primary THEN
  INSERT INTO public.inbox_integrity_audit(account_id,actor_id,event_type,channel_id,connection_id,membership_id,evidence_ref)
  VALUES(p_account,p_actor,'primary_selected',ch,p_connection,ep.id,p_evidence_ref);
 END IF;
 RETURN jsonb_build_object('channel_id',ch,'membership_id',ep.id,'primary',p_primary OR ep.is_primary);
END $$;
REVOKE ALL ON FUNCTION public.inbox_enroll_verified_channel(uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_enroll_verified_channel(uuid,uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,text,boolean) TO service_role;


CREATE FUNCTION wacrm_internal.inbox_audit_epoch_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
  INSERT INTO public.inbox_integrity_audit(account_id,actor_id,event_type,channel_id,connection_id,membership_id,evidence_ref)
  VALUES(OLD.account_id,auth.uid(),'membership_closed',OLD.channel_id,OLD.connection_id,OLD.id,OLD.evidence_ref);
 ELSIF NEW.is_primary IS DISTINCT FROM OLD.is_primary THEN
  INSERT INTO public.inbox_integrity_audit(account_id,actor_id,event_type,channel_id,connection_id,membership_id,evidence_ref)
  VALUES(OLD.account_id,auth.uid(),'primary_changed',OLD.channel_id,OLD.connection_id,OLD.id,OLD.evidence_ref);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_audit_epoch_change() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER inbox_audit_epoch_change AFTER UPDATE ON public.whatsapp_channel_memberships FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_audit_epoch_change();

ALTER TABLE public.inbox_threads ADD COLUMN last_message_preview text;
ALTER TABLE public.inbox_message_memberships ADD COLUMN read_before_move boolean NOT NULL DEFAULT false;
-- Scope-safe reparenting is a single source UPDATE plus matching shadow changes.
ALTER TABLE public.inbox_message_memberships ALTER CONSTRAINT inbox_message_memberships_conversation_id_message_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.inbox_verified_message_evidence ALTER CONSTRAINT inbox_verified_message_evidence_conversation_id_message_id_fkey DEFERRABLE INITIALLY DEFERRED;
-- Source timestamps and content never independently prove trusted ingress.
-- Only a future server-authenticated ingress association can contribute to
-- known unread / trusted window. Historical projection cannot open a window.
CREATE FUNCTION public.inbox_rebuild_thread(p_account uuid,p_thread uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE t public.inbox_threads%ROWTYPE; last_row record; n bigint; inbound_at timestamptz;
BEGIN
 SELECT * INTO t FROM public.inbox_threads WHERE account_id=p_account AND id=p_thread FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.conversations WHERE id=t.conversation_id AND account_id=p_account) THEN RETURN false; END IF;
 SELECT m.id,m.created_at,left(coalesce(nullif(m.content_text,''),'['||m.content_type||']'),240) preview
 INTO last_row FROM public.inbox_message_memberships im
 JOIN public.messages m ON m.id=im.message_id AND m.conversation_id=im.conversation_id
 AND m.provider=im.provider AND m.connection_id=im.connection_id
 WHERE im.account_id=p_account AND im.thread_id=p_thread ORDER BY m.created_at DESC NULLS LAST,m.id DESC LIMIT 1;
 SELECT count(*) FILTER(WHERE im.evidence_kind='verified_current_ingress' AND m.sender_type='customer' AND im.ingest_sequence>t.read_watermark AND NOT im.read_before_move),
 max(m.created_at) FILTER(WHERE im.evidence_kind='verified_current_ingress' AND m.sender_type='customer')
 INTO n,inbound_at FROM public.inbox_message_memberships im
 JOIN public.messages m ON m.id=im.message_id AND m.conversation_id=im.conversation_id AND m.provider=im.provider AND m.connection_id=im.connection_id
 WHERE im.account_id=p_account AND im.thread_id=p_thread;
 UPDATE public.inbox_threads SET last_message_id=last_row.id,last_message_at=last_row.created_at,last_message_preview=last_row.preview,
 unread_count_known=n,last_trusted_inbound_at=inbound_at
 WHERE account_id=p_account AND id=p_thread;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.inbox_rebuild_thread(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_rebuild_thread(uuid,uuid) TO service_role;

-- Synchronize on evidence insert, to prevent a concurrent source move/delete
-- leaving a stale proof. Historical observed_at must be inside its proven epoch.
CREATE FUNCTION public.inbox_validate_historical_evidence()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id
 WHERE m.id=NEW.message_id AND m.conversation_id=NEW.conversation_id AND c.account_id=NEW.account_id
 AND m.connection_id=NEW.connection_id AND m.provider=NEW.provider AND m.provider_message_id=NEW.native_message_id FOR UPDATE OF m;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_HISTORICAL_PROOF_SCOPE' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM public.whatsapp_channel_memberships ep
 WHERE ep.id=NEW.membership_id AND ep.account_id=NEW.account_id AND ep.provider=NEW.provider AND ep.channel_id=NEW.channel_id AND ep.connection_id=NEW.connection_id
 AND NEW.observed_at>=ep.valid_from AND (ep.valid_until IS NULL OR NEW.observed_at<ep.valid_until)
 AND NEW.observed_at<=clock_timestamp()+interval '10 seconds' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_HISTORICAL_PROOF_SCOPE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.inbox_validate_historical_evidence() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER inbox_validate_historical_evidence BEFORE INSERT ON public.inbox_verified_message_evidence
FOR EACH ROW EXECUTE FUNCTION public.inbox_validate_historical_evidence();

-- Keep projection in sync on backfill association insertion. No new
-- association is inferred from an ordinary legacy source INSERT.
CREATE FUNCTION wacrm_internal.inbox_after_association_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.inbox_rebuild_thread(NEW.account_id,NEW.thread_id);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_after_association_insert() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER inbox_after_association_insert AFTER INSERT ON public.inbox_message_memberships
FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_after_association_insert();

-- Server-authored provenance is not editable by the browser, even if legacy
-- RLS permits other message writes. Browser cannot change verified identity or
-- move a verified source. Nonassociated legacy inserts remain untrusted.
CREATE FUNCTION wacrm_internal.inbox_guard_verified_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF current_setting('role',true) IN ('anon','authenticated') AND (
  NEW.id IS DISTINCT FROM OLD.id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
  OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.provider IS DISTINCT FROM OLD.provider
  OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id OR NEW.message_id IS DISTINCT FROM OLD.message_id
  OR NEW.sender_type IS DISTINCT FROM OLD.sender_type OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR NEW.provider_chat_id IS DISTINCT FROM OLD.provider_chat_id
 ) AND (EXISTS(SELECT 1 FROM public.inbox_message_memberships WHERE message_id=OLD.id)
     OR EXISTS(SELECT 1 FROM public.inbox_verified_message_evidence WHERE message_id=OLD.id))
 THEN RAISE EXCEPTION 'INBOX_VERIFIED_SOURCE_SERVER_ONLY' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_guard_verified_source() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER inbox_guard_verified_source BEFORE UPDATE ON public.messages
 FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_guard_verified_source();

-- Native IDs/route/time change invalidates the proof, never guesses a new
-- channel. Same-account reparent with unchanged native proof retains original
-- membership epoch and message ID, assigns target sequence, and rebuilds both.
-- Private trigger cannot be invoked as an RPC; only touches actual OLD/NEW rows.
CREATE FUNCTION wacrm_internal.inbox_maintain_source_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE im public.inbox_message_memberships%ROWTYPE; e public.inbox_verified_message_evidence%ROWTYPE;
 oldt public.inbox_threads%ROWTYPE; newt public.inbox_threads%ROWTYPE; dest_account uuid; invalid boolean; a uuid; ch uuid; conn uuid; ep uuid; proof text;
BEGIN
 SELECT * INTO im FROM public.inbox_message_memberships WHERE message_id=OLD.id FOR UPDATE;
 SELECT * INTO e FROM public.inbox_verified_message_evidence WHERE message_id=OLD.id FOR UPDATE;
 IF im.message_id IS NULL AND e.message_id IS NULL THEN RETURN NEW; END IF;
 a=coalesce(im.account_id,e.account_id); ch=coalesce(im.channel_id,e.channel_id); conn=coalesce(im.connection_id,e.connection_id); ep=coalesce(im.membership_id,e.membership_id); proof=coalesce(im.evidence_ref,e.evidence_ref);
 SELECT account_id INTO dest_account FROM public.conversations WHERE id=NEW.conversation_id;
 IF dest_account IS DISTINCT FROM a THEN RAISE EXCEPTION 'INBOX_CROSS_ACCOUNT_SOURCE_MOVE' USING ERRCODE='23514'; END IF;
 invalid=NEW.id IS DISTINCT FROM OLD.id OR NEW.provider IS DISTINCT FROM OLD.provider
 OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
 OR NEW.message_id IS DISTINCT FROM OLD.message_id OR NEW.sender_type IS DISTINCT FROM OLD.sender_type
 OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.provider_chat_id IS DISTINCT FROM OLD.provider_chat_id;
 IF invalid THEN
  DELETE FROM public.inbox_verified_message_evidence WHERE message_id=OLD.id AND account_id=a;
  DELETE FROM public.inbox_message_memberships WHERE message_id=OLD.id AND account_id=a;
  INSERT INTO public.inbox_integrity_audit(account_id,actor_id,event_type,channel_id,connection_id,membership_id,message_id,conversation_id,evidence_ref)
  VALUES(a,auth.uid(),'message_identity_invalidated',ch,conn,ep,OLD.id,OLD.conversation_id,proof);
  IF im.thread_id IS NOT NULL THEN PERFORM public.inbox_rebuild_thread(a,im.thread_id); END IF;
  RETURN NEW;
 END IF;
 IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
  IF e.message_id IS NOT NULL THEN UPDATE public.inbox_verified_message_evidence SET conversation_id=NEW.conversation_id WHERE message_id=OLD.id AND account_id=a; END IF;
  IF im.message_id IS NOT NULL THEN
   INSERT INTO public.inbox_threads(account_id,conversation_id,channel_id,provider) VALUES(a,NEW.conversation_id,ch,im.provider)
   ON CONFLICT(account_id,conversation_id,channel_id) DO NOTHING;
   SELECT * INTO STRICT newt FROM public.inbox_threads WHERE account_id=a AND conversation_id=NEW.conversation_id AND channel_id=ch;
   -- Lock both threads deterministically; a moved previously-read message
   -- cannot become unread solely because its sequence changed.
   PERFORM 1 FROM public.inbox_threads WHERE account_id=a AND id IN(im.thread_id,newt.id) ORDER BY id FOR UPDATE;
   SELECT * INTO STRICT oldt FROM public.inbox_threads WHERE id=im.thread_id AND account_id=a;
   SELECT * INTO STRICT newt FROM public.inbox_threads WHERE id=newt.id AND account_id=a;
   UPDATE public.inbox_threads SET ingest_highwater=newt.ingest_highwater+1 WHERE id=newt.id AND account_id=a;
   UPDATE public.inbox_message_memberships SET conversation_id=NEW.conversation_id,thread_id=newt.id,ingest_sequence=newt.ingest_highwater+1,
    read_before_move=im.read_before_move OR im.ingest_sequence<=oldt.read_watermark WHERE message_id=OLD.id AND account_id=a;
   PERFORM public.inbox_rebuild_thread(a,newt.id);
   PERFORM public.inbox_rebuild_thread(a,im.thread_id);
  END IF;
  INSERT INTO public.inbox_integrity_audit(account_id,actor_id,event_type,channel_id,connection_id,membership_id,message_id,conversation_id,previous_conversation_id,evidence_ref)
  VALUES(a,auth.uid(),'message_reparented',ch,conn,ep,OLD.id,NEW.conversation_id,OLD.conversation_id,proof);
 ELSIF im.thread_id IS NOT NULL AND (NEW.content_text IS DISTINCT FROM OLD.content_text OR NEW.content_type IS DISTINCT FROM OLD.content_type) THEN
  PERFORM public.inbox_rebuild_thread(a,im.thread_id);
 END IF;
 -- ACK/status/media URL only: no reorder, no unread change.
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_maintain_source_update() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER inbox_maintain_source_update AFTER UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_maintain_source_update();

CREATE FUNCTION wacrm_internal.inbox_maintain_source_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE im public.inbox_message_memberships%ROWTYPE; e public.inbox_verified_message_evidence%ROWTYPE; a uuid;
BEGIN
 SELECT * INTO im FROM public.inbox_message_memberships WHERE message_id=OLD.id FOR UPDATE;
 SELECT * INTO e FROM public.inbox_verified_message_evidence WHERE message_id=OLD.id FOR UPDATE;
 IF im.message_id IS NULL AND e.message_id IS NULL THEN RETURN OLD; END IF;
 a=coalesce(im.account_id,e.account_id);
 DELETE FROM public.inbox_verified_message_evidence WHERE account_id=a AND message_id=OLD.id;
 DELETE FROM public.inbox_message_memberships WHERE account_id=a AND message_id=OLD.id;
 INSERT INTO public.inbox_integrity_audit(account_id,actor_id,event_type,channel_id,connection_id,membership_id,message_id,conversation_id,evidence_ref)
 SELECT a,auth.uid(),'message_deleted',coalesce(im.channel_id,e.channel_id),coalesce(im.connection_id,e.connection_id),coalesce(im.membership_id,e.membership_id),OLD.id,OLD.conversation_id,coalesce(im.evidence_ref,e.evidence_ref) WHERE EXISTS(SELECT 1 FROM public.accounts WHERE id=a);
 IF im.thread_id IS NOT NULL THEN PERFORM public.inbox_rebuild_thread(a,im.thread_id); END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_maintain_source_delete() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER inbox_maintain_source_delete BEFORE DELETE ON public.messages FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_maintain_source_delete();

-- The unresolved legacy bucket mirrors the authoritative CRM count while shadow
-- mode is in use. Contact reparent preserves stable parent/thread IDs.
CREATE FUNCTION wacrm_internal.inbox_maintain_legacy_parent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.inbox_threads WHERE account_id=OLD.account_id AND conversation_id=OLD.id)
    OR EXISTS(SELECT 1 FROM public.inbox_legacy_unread WHERE account_id=OLD.account_id AND conversation_id=OLD.id) THEN
   INSERT INTO public.inbox_integrity_audit(account_id,actor_id,event_type,conversation_id)
   SELECT OLD.account_id,auth.uid(),'legacy_parent_deleted',OLD.id WHERE EXISTS(SELECT 1 FROM public.accounts WHERE id=OLD.account_id);
  END IF;
  RETURN OLD;
 END IF;
 IF NEW.account_id IS DISTINCT FROM OLD.account_id AND
    (EXISTS(SELECT 1 FROM public.inbox_threads WHERE conversation_id=OLD.id)
    OR EXISTS(SELECT 1 FROM public.inbox_verified_message_evidence WHERE conversation_id=OLD.id)
    OR EXISTS(SELECT 1 FROM public.inbox_legacy_unread WHERE conversation_id=OLD.id))
 THEN RAISE EXCEPTION 'INBOX_PARENT_TENANT_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW.unread_count IS DISTINCT FROM OLD.unread_count THEN
  INSERT INTO public.inbox_legacy_unread(account_id,conversation_id,unread_count)
  VALUES(NEW.account_id,NEW.id,coalesce(NEW.unread_count,0))
  ON CONFLICT(account_id,conversation_id) DO UPDATE SET unread_count=excluded.unread_count,captured_at=clock_timestamp(),acknowledged_at=NULL;
 END IF;
 IF NEW.contact_id IS DISTINCT FROM OLD.contact_id AND EXISTS(SELECT 1 FROM public.inbox_threads WHERE account_id=NEW.account_id AND conversation_id=NEW.id) THEN
  INSERT INTO public.inbox_integrity_audit(account_id,actor_id,event_type,conversation_id)
  VALUES(NEW.account_id,auth.uid(),'contact_reparented',NEW.id);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_maintain_legacy_parent() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER inbox_maintain_legacy_parent_update AFTER UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_maintain_legacy_parent();
CREATE TRIGGER inbox_maintain_legacy_parent_delete BEFORE DELETE ON public.conversations FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_maintain_legacy_parent();
-- Existing unread is copied only into explicitly unallocated legacy bucket, not
-- guessed per-channel. No source changes, effects or historical trust.
INSERT INTO public.inbox_legacy_unread(account_id,conversation_id,unread_count)
 SELECT account_id,id,coalesce(unread_count,0) FROM public.conversations WHERE coalesce(unread_count,0)>0
 ON CONFLICT(account_id,conversation_id) DO NOTHING;

-- Rebuild existing shadow rows (in TEST none yet; safe for replay).
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT account_id,id FROM public.inbox_threads LOOP
  PERFORM public.inbox_rebuild_thread(t.account_id,t.id);
 END LOOP;
END $$;

-- SOF-89 will install authenticated current-ingress provenance; until then
-- permit only historical association with exact independently stored proof.
CREATE OR REPLACE FUNCTION public.inbox_guard_message_membership()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.evidence_kind<>'verified_historical_epoch' THEN RAISE EXCEPTION 'INBOX_CURRENT_INGRESS_NOT_ACTIVATED' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id
 JOIN public.inbox_verified_message_evidence e ON e.message_id=m.id AND e.conversation_id=m.conversation_id AND e.native_message_id=m.provider_message_id
 WHERE m.id=NEW.message_id AND m.conversation_id=NEW.conversation_id AND c.account_id=NEW.account_id
 AND m.provider=NEW.provider AND m.connection_id=NEW.connection_id AND e.account_id=NEW.account_id AND e.channel_id=NEW.channel_id
 AND e.provider=NEW.provider AND e.connection_id=NEW.connection_id AND e.membership_id=NEW.membership_id AND e.evidence_ref=NEW.evidence_ref)
 THEN RAISE EXCEPTION 'INBOX_MESSAGE_PROOF_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.inbox_guard_message_membership() FROM PUBLIC,anon,authenticated;
CREATE FUNCTION wacrm_internal.inbox_guard_parent_contact_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.contacts WHERE id=NEW.contact_id AND account_id=NEW.account_id)
 THEN RAISE EXCEPTION 'INBOX_PARENT_CONTACT_SCOPE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_guard_parent_contact_scope() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER inbox_guard_parent_contact_scope BEFORE INSERT OR UPDATE OF contact_id,account_id ON public.conversations
FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_guard_parent_contact_scope();
