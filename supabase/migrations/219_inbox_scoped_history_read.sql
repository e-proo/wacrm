-- SOF-84: channel-local CRM read, bounded reactions and safe realtime invalidations.
-- The legacy CRM unread and provider receipt state are deliberately not mutated.
CREATE FUNCTION public.inbox_mark_thread_read(p_account uuid,p_actor uuid,p_thread uuid,p_channel uuid,p_seen bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE t public.inbox_threads%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE account_id=p_account AND user_id=p_actor AND account_role IN ('owner','admin','agent')) THEN
  RAISE EXCEPTION 'INBOX_READ_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 SELECT * INTO t FROM public.inbox_threads WHERE account_id=p_account AND id=p_thread AND channel_id=p_channel FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.inbox_read_channel_directory(p_account) d WHERE d.id=p_channel AND d.provider=t.provider AND d.ready) THEN RETURN NULL; END IF;
 IF p_seen IS NULL OR p_seen<0 OR p_seen>t.ingest_highwater THEN RAISE EXCEPTION 'INBOX_READ_WATERMARK_INVALID' USING ERRCODE='22023'; END IF;
 IF p_seen>t.read_watermark THEN
  UPDATE public.inbox_threads SET read_watermark=p_seen WHERE account_id=p_account AND id=p_thread;
  PERFORM public.inbox_rebuild_thread(p_account,p_thread);
 END IF;
 SELECT * INTO STRICT t FROM public.inbox_threads WHERE account_id=p_account AND id=p_thread;
 RETURN jsonb_build_object('thread_id',t.id,'channel_id',t.channel_id,'read_watermark',t.read_watermark::text,'unread_count_known',t.unread_count_known);
END $$;
REVOKE ALL ON FUNCTION public.inbox_mark_thread_read(uuid,uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_mark_thread_read(uuid,uuid,uuid,uuid,bigint) TO service_role;

-- Enrich only the exact authorized page, not arbitrary message IDs or actor IDs.
-- Hosted TEST has this grant already; clean replay needs explicit minimal columns.
GRANT SELECT(message_id,conversation_id,actor_type,actor_id,emoji) ON public.message_reactions TO service_role;
CREATE FUNCTION public.inbox_read_history_with_reactions(p_account uuid,p_actor uuid,p_scope text,p_channel uuid,p_parent uuid,p_thread uuid,p_limit integer,p_before_at timestamptz,p_before_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE page jsonb; rows jsonb;
BEGIN
 page=public.inbox_read_page(p_account,p_actor,'history',p_scope,p_channel,p_parent,p_thread,NULL,NULL,NULL,p_limit,p_before_at,p_before_id);
 IF page IS NULL THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(jsonb_set(r.value,'{payload,reactions}',coalesce((
  SELECT jsonb_agg(to_jsonb(g) ORDER BY g.emoji) FROM (
   SELECT mr.emoji,count(*) AS count,bool_or(mr.actor_type='agent' AND mr.actor_id=p_actor) AS mine
   FROM public.message_reactions mr
   WHERE mr.message_id=(r.value->>'row_id')::uuid AND mr.conversation_id=(page->>'conversation_id')::uuid
   GROUP BY mr.emoji ORDER BY mr.emoji LIMIT 50
  ) g
 ),'[]'::jsonb)) ORDER BY r.ordinality),'[]'::jsonb)
 INTO rows FROM jsonb_array_elements(page->'rows') WITH ORDINALITY r(value,ordinality);
 RETURN jsonb_set(page,'{rows}',rows);
END $$;
REVOKE ALL ON FUNCTION public.inbox_read_history_with_reactions(uuid,uuid,text,uuid,uuid,uuid,integer,timestamptz,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_read_history_with_reactions(uuid,uuid,text,uuid,uuid,uuid,integer,timestamptz,uuid) TO service_role;

-- No message body, native ID, sender route or credential is published. Clients
-- receive a wake-up only; every refresh goes through the scoped read API.
CREATE TABLE public.inbox_thread_changes (
 -- Opaque replica identity: a DELETE WAL event cannot disclose a tenant or
 -- thread identifier (Postgres Changes does not apply RLS to DELETE events).
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL,
 thread_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 UNIQUE(account_id,thread_id)
);
ALTER TABLE public.inbox_thread_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbox_thread_changes FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.inbox_thread_changes TO authenticated;
CREATE POLICY inbox_thread_changes_member ON public.inbox_thread_changes FOR SELECT TO authenticated USING (public.is_account_member(account_id));
-- Only internal projection triggers write this signal; no browser writes.
CREATE FUNCTION wacrm_internal.inbox_emit_thread_change(p_account uuid,p_thread uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 INSERT INTO public.inbox_thread_changes(account_id,thread_id) VALUES(p_account,p_thread)
 ON CONFLICT(account_id,thread_id) DO UPDATE SET revision=public.inbox_thread_changes.revision+1;
$$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_emit_thread_change(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION wacrm_internal.inbox_thread_change_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM public.inbox_thread_changes WHERE account_id=OLD.account_id AND thread_id=OLD.id;
  RETURN OLD;
 END IF;
 PERFORM wacrm_internal.inbox_emit_thread_change(NEW.account_id,NEW.id);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_thread_change_trigger() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER inbox_thread_change_signal AFTER INSERT OR UPDATE OR DELETE ON public.inbox_threads
 FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_thread_change_trigger();
CREATE FUNCTION wacrm_internal.inbox_reaction_change_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a uuid; t uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN
  SELECT account_id,thread_id INTO a,t FROM public.inbox_message_memberships WHERE message_id=OLD.message_id AND conversation_id=OLD.conversation_id;
  IF FOUND THEN PERFORM wacrm_internal.inbox_emit_thread_change(a,t); END IF;
 END IF;
 IF TG_OP<>'DELETE' THEN
  SELECT account_id,thread_id INTO a,t FROM public.inbox_message_memberships WHERE message_id=NEW.message_id AND conversation_id=NEW.conversation_id;
  IF FOUND THEN PERFORM wacrm_internal.inbox_emit_thread_change(a,t); END IF;
  RETURN NEW;
 END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION wacrm_internal.inbox_reaction_change_trigger() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER inbox_reaction_change_signal AFTER INSERT OR UPDATE OR DELETE ON public.message_reactions
 FOR EACH ROW EXECUTE FUNCTION wacrm_internal.inbox_reaction_change_trigger();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') AND NOT EXISTS(
  SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='inbox_thread_changes'
 ) THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.inbox_thread_changes; END IF;
END $$;
