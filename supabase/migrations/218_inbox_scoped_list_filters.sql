-- SOF-77: same canonical projection, exact server-side list filters and counts.
-- No mutation of source, watermarks, provider state or grants for browsers.
GRANT SELECT ON public.tags,public.contact_tags TO service_role;

-- Safe verified channel labels for legacy disambiguation.
CREATE OR REPLACE FUNCTION public.inbox_read_thread_rows(p_account uuid,p_scope text,p_channel uuid,p_parent uuid,p_connection uuid,p_status text,p_search text)
RETURNS TABLE(row_id uuid,sort_at timestamptz,payload jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT t.id,t.last_message_at,jsonb_build_object(
 'id',t.id,'conversation_id',t.conversation_id,'channel_id',t.channel_id,'provider',t.provider,'channel_name',d.display_name,'own_phone',d.own_phone,
 'scope',CASE WHEN d.ready THEN 'active' ELSE 'historical' END,'read_only',true,'route_ready',d.ready,
 'status',c.status,'thread_state',t.state,'last_message_at',t.last_message_at,'last_message_id',t.last_message_id,
 'preview',t.last_message_preview,'unread_count_known',t.unread_count_known,'inherited_unread',t.inherited_unread,
 'contact',jsonb_build_object('id',ct.id,'name',ct.name,'phone',ct.phone,'company',ct.company))
 FROM public.inbox_threads t JOIN public.inbox_read_channel_directory(p_account) d ON d.id=t.channel_id AND d.provider=t.provider
 JOIN public.conversations c ON c.account_id=t.account_id AND c.id=t.conversation_id
 JOIN public.contacts ct ON ct.account_id=c.account_id AND ct.id=c.contact_id
 WHERE t.account_id=p_account AND p_scope IN ('active','historical','all')
 AND (p_scope='all' OR d.ready=(p_scope='active'))
 AND (p_channel IS NULL OR t.channel_id=p_channel) AND (p_parent IS NULL OR t.conversation_id=p_parent)
 -- A verified same-channel session (including an earlier epoch) may resolve
 -- the same logical history; a re-paired connection can yield multiple
 -- candidates, never an automatic route selection.
 AND (p_connection IS NULL OR EXISTS(SELECT 1 FROM public.whatsapp_channel_memberships ep WHERE ep.account_id=p_account AND ep.channel_id=t.channel_id AND ep.provider=t.provider AND ep.connection_id=p_connection))
 AND (p_status IS NULL OR c.status=p_status)
 AND (p_search IS NULL OR strpos(lower(concat_ws(' ',ct.name,ct.phone,ct.company)),lower(p_search))>0)
 UNION ALL
 SELECT c.id,latest.created_at,jsonb_build_object('id',c.id,'conversation_id',c.id,'channel_id',NULL,'provider',NULL,
 'scope','unknown','read_only',true,'route_ready',false,'status',c.status,'last_message_at',latest.created_at,'last_message_id',latest.id,
 'preview',latest.preview,'unread_count_known',NULL,'legacy_crm_unread',coalesce(lu.unread_count,c.unread_count,0),
 'legacy_unread_is_additive',false,'contact',jsonb_build_object('id',ct.id,'name',ct.name,'phone',ct.phone,'company',ct.company))
 FROM public.conversations c JOIN public.contacts ct ON ct.id=c.contact_id AND ct.account_id=c.account_id
 LEFT JOIN public.inbox_legacy_unread lu ON lu.account_id=c.account_id AND lu.conversation_id=c.id
 LEFT JOIN LATERAL (SELECT m.id,m.created_at,left(coalesce(nullif(m.content_text,''),'['||m.content_type||']'),240) preview
 FROM public.messages m WHERE m.conversation_id=c.id AND NOT EXISTS(SELECT 1 FROM public.inbox_message_memberships im WHERE im.message_id=m.id AND im.account_id=p_account)
 AND (p_connection IS NULL OR m.connection_id=p_connection)
 ORDER BY m.created_at DESC NULLS LAST,m.id DESC LIMIT 1) latest ON true
 WHERE c.account_id=p_account AND p_scope IN ('unknown','all') AND p_channel IS NULL
 AND (p_parent IS NULL OR c.id=p_parent) AND (p_status IS NULL OR c.status=p_status)
 AND (p_search IS NULL OR strpos(lower(concat_ws(' ',ct.name,ct.phone,ct.company)),lower(p_search))>0)
 AND (latest.id IS NOT NULL OR (p_connection IS NULL AND (coalesce(lu.unread_count,c.unread_count,0)>0 OR NOT EXISTS(SELECT 1 FROM public.messages m WHERE m.conversation_id=c.id))))
$$;

CREATE FUNCTION public.inbox_read_filtered_rows(p_account uuid,p_actor uuid,p_scope text,p_channel uuid,p_status text,p_search text,p_unread boolean,p_assignment text,p_tags uuid[],p_company text,p_exact uuid)
RETURNS TABLE(row_id uuid,sort_at timestamptz,payload jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT r.row_id,r.sort_at,r.payload||jsonb_build_object(
 'channel_name',d.display_name,'own_phone',d.own_phone,
 'assigned_agent_id',ap.user_id,'assigned_agent_name',ap.full_name,'assigned_to_me',coalesce(c.assigned_agent_id=p_actor,false))
 FROM public.inbox_read_thread_rows(p_account,p_scope,p_channel,NULL,NULL,p_status,NULL) r
 JOIN public.conversations c ON c.account_id=p_account AND c.id=(r.payload->>'conversation_id')::uuid
 JOIN public.contacts ct ON ct.account_id=p_account AND ct.id=c.contact_id
 LEFT JOIN public.profiles ap ON ap.account_id=p_account AND ap.user_id=c.assigned_agent_id
 LEFT JOIN public.inbox_read_channel_directory(p_account) d ON d.id=(r.payload->>'channel_id')::uuid
 WHERE (p_exact IS NULL OR r.row_id=p_exact)
 AND (NOT p_unread OR CASE WHEN r.payload->>'scope'='unknown' THEN coalesce((r.payload->>'legacy_crm_unread')::bigint,0)>0 ELSE coalesce((r.payload->>'unread_count_known')::bigint,0)>0 END)
 AND (p_assignment='all' OR (p_assignment='mine' AND c.assigned_agent_id=p_actor) OR (p_assignment='unassigned' AND c.assigned_agent_id IS NULL))
 AND (p_company IS NULL OR btrim(ct.company)=p_company)
 AND (coalesce(cardinality(p_tags),0)=0 OR EXISTS(SELECT 1 FROM public.contact_tags x JOIN public.tags tg ON tg.id=x.tag_id AND tg.account_id=p_account WHERE x.contact_id=ct.id AND tg.id=ANY(p_tags)))
 AND (p_search IS NULL OR strpos(lower(concat_ws(' ',ct.name,ct.phone,ct.company,r.payload->>'preview')),lower(p_search))>0)
$$;
REVOKE ALL ON FUNCTION public.inbox_read_filtered_rows(uuid,uuid,text,uuid,text,text,boolean,text,uuid[],text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_read_filtered_rows(uuid,uuid,text,uuid,text,text,boolean,text,uuid[],text,uuid) TO service_role;

CREATE FUNCTION public.inbox_read_filtered_page(p_account uuid,p_actor uuid,p_op text,p_scope text,p_channel uuid,p_status text,p_search text,p_unread boolean,p_assignment text,p_tags uuid[],p_company text,p_exact uuid,p_limit integer,p_before_at timestamptz,p_before_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=p_actor AND account_id=p_account AND account_role IN ('owner','admin','agent','viewer')) THEN RAISE EXCEPTION 'INBOX_READ_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF p_op IS NULL OR p_op NOT IN ('threads','counts','tags')
 OR p_scope IS NULL OR p_scope NOT IN ('active','historical','unknown','all')
 OR (p_scope='all' AND p_op='threads') OR (p_scope='unknown' AND p_channel IS NOT NULL)
 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_unread IS NULL OR p_assignment IS NULL OR p_assignment NOT IN ('all','mine','unassigned')
 OR coalesce(cardinality(p_tags),0)>20 OR array_position(p_tags,NULL::uuid) IS NOT NULL
 OR (p_status IS NOT NULL AND p_status NOT IN ('open','pending','closed'))
 OR length(coalesce(p_search,''))>120 OR length(coalesce(p_company,''))>160
 OR (p_before_at IS NOT NULL AND p_before_id IS NULL)
 OR (p_op='counts' AND (p_before_id IS NOT NULL OR p_exact IS NOT NULL))
 OR (p_op='tags' AND (p_scope<>'all' OR p_channel IS NOT NULL OR p_status IS NOT NULL OR p_search IS NOT NULL OR p_unread OR p_assignment<>'all' OR coalesce(cardinality(p_tags),0)>0 OR p_company IS NOT NULL OR p_exact IS NOT NULL))
 THEN RAISE EXCEPTION 'INBOX_READ_INVALID' USING ERRCODE='22023'; END IF;
 IF p_channel IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.whatsapp_channels WHERE account_id=p_account AND id=p_channel) THEN RETURN NULL; END IF;
 IF p_op='tags' THEN
  WITH page AS (SELECT t.id row_id,t.created_at sort_at,jsonb_build_object('id',t.id,'name',t.name) payload FROM public.tags t
   WHERE t.account_id=p_account AND (p_before_id IS NULL OR (p_before_at IS NOT NULL AND (t.created_at<p_before_at OR t.created_at IS NULL)) OR (t.created_at IS NOT DISTINCT FROM p_before_at AND t.id<p_before_id))
   ORDER BY sort_at DESC NULLS LAST,row_id DESC LIMIT p_limit+1)
  SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY sort_at DESC NULLS LAST,row_id DESC),'[]'::jsonb) INTO result FROM page;
  RETURN jsonb_build_object('rows',result,'read_only',true);
 END IF;
 IF p_op='threads' THEN
  WITH page AS (SELECT * FROM public.inbox_read_filtered_rows(p_account,p_actor,p_scope,p_channel,p_status,p_search,p_unread,p_assignment,p_tags,p_company,p_exact) r
   WHERE p_before_id IS NULL OR (p_before_at IS NOT NULL AND (r.sort_at<p_before_at OR r.sort_at IS NULL)) OR (r.sort_at IS NOT DISTINCT FROM p_before_at AND r.row_id<p_before_id)
   ORDER BY sort_at DESC NULLS LAST,row_id DESC LIMIT p_limit+1)
  SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY sort_at DESC NULLS LAST,row_id DESC),'[]'::jsonb) INTO result FROM page;
  RETURN jsonb_build_object('rows',result,'read_only',true);
 END IF;
 WITH inv AS (SELECT * FROM public.inbox_legacy_inventory(p_account)),
 lane AS MATERIALIZED (SELECT * FROM public.inbox_read_filtered_rows(p_account,p_actor,p_scope,p_channel,p_status,p_search,p_unread,p_assignment,p_tags,p_company,NULL)),
 counts AS (SELECT count(*) threads,coalesce(sum((payload->>'unread_count_known')::bigint),0) known_unread,
  count(*) FILTER(WHERE (payload->>'unread_count_known')::bigint>0) known_unread_threads,
  coalesce(sum((payload->>'legacy_crm_unread')::bigint),0) legacy_lane_unread FROM lane),
 lane_messages AS (SELECT count(*) n FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id AND c.account_id=p_account
 LEFT JOIN public.inbox_message_memberships im ON im.message_id=m.id AND im.account_id=p_account AND im.conversation_id=m.conversation_id
 WHERE EXISTS(SELECT 1 FROM lane l WHERE (im.message_id IS NOT NULL AND l.payload->>'scope'<>'unknown' AND l.row_id=im.thread_id AND l.payload->>'channel_id'=im.channel_id::text AND im.provider=m.provider AND im.connection_id=m.connection_id)
 OR (im.message_id IS NULL AND l.payload->>'scope'='unknown' AND l.row_id=m.conversation_id)))
 SELECT jsonb_build_object('counts',jsonb_build_object('threads',counts.threads,'known_unread',counts.known_unread,'known_unread_threads',counts.known_unread_threads,
 'legacy_lane_unread',counts.legacy_lane_unread,'lane_messages',lane_messages.n,'scope',p_scope,'channel_id',p_channel,
 'source_messages',inv.source_messages,'associated_messages',inv.associated_messages,'unresolved_messages',inv.unresolved_messages,
 'legacy_crm_unread',inv.legacy_unread,'legacy_unread_is_additive',false),'read_only',true) INTO result FROM counts CROSS JOIN inv CROSS JOIN lane_messages;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.inbox_read_filtered_page(uuid,uuid,text,text,uuid,text,text,boolean,text,uuid[],text,uuid,integer,timestamptz,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_read_filtered_page(uuid,uuid,text,text,uuid,text,text,boolean,text,uuid[],text,uuid,integer,timestamptz,uuid) TO service_role;
