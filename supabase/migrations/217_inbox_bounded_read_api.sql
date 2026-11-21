-- SOF-83: server-only bounded read contract. No backfill, sends or read mutation.
GRANT SELECT ON public.profiles,public.contacts,public.conversations,public.messages TO service_role;
CREATE INDEX inbox_read_message_timeline_idx ON public.messages(conversation_id,created_at DESC NULLS LAST,id DESC);
CREATE INDEX inbox_read_channel_members_idx ON public.whatsapp_channel_memberships(account_id,channel_id,connection_id,valid_until);
-- Ready means a current verified route is online, NOT permission to send.
CREATE FUNCTION public.inbox_read_ready_sessions(p_account uuid)
RETURNS TABLE(channel_id uuid,connection_id uuid,is_primary boolean)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT ch.id,w.id,ep.is_primary
 FROM public.whatsapp_channels ch
 JOIN public.whatsapp_channel_memberships ep ON ep.account_id=ch.account_id AND ep.provider=ch.provider AND ep.channel_id=ch.id
 JOIN public.whatsapp_connections w ON w.account_id=ep.account_id AND w.provider=ep.provider AND w.id=ep.connection_id
 WHERE ch.account_id=p_account AND ep.valid_until IS NULL AND w.archived_at IS NULL
 AND ((w.provider='openwa' AND w.status IN ('ready','connected') AND w.session_id IS NOT DISTINCT FROM ep.session_snapshot AND w.instance_id IS NOT DISTINCT FROM ep.instance_snapshot
    AND regexp_replace(coalesce(w.phone_identity,''),'^\+','')=split_part(ch.identity_key,':',2))
 OR (w.provider='meta_cloud' AND w.status='connected' AND w.provider_external_id=ep.external_snapshot))
$$;
REVOKE ALL ON FUNCTION public.inbox_read_ready_sessions(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_read_ready_sessions(uuid) TO service_role;

CREATE FUNCTION public.inbox_read_channel_directory(p_account uuid)
RETURNS TABLE(id uuid,provider text,display_name text,own_phone text,ready boolean,primary_connection_id uuid,ready_sessions bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT ch.id,ch.provider,ch.display_name,CASE WHEN ch.provider='openwa' THEN '+'||split_part(ch.identity_key,':',2) END,
 coalesce(x.ready_sessions,0)>0,x.primary_connection_id,coalesce(x.ready_sessions,0)
 FROM public.whatsapp_channels ch
 LEFT JOIN (SELECT channel_id,count(*) ready_sessions,(array_agg(connection_id ORDER BY connection_id) FILTER(WHERE is_primary))[1] primary_connection_id
 FROM public.inbox_read_ready_sessions(p_account) GROUP BY channel_id) x ON x.channel_id=ch.id
 WHERE ch.account_id=p_account
$$;
REVOKE ALL ON FUNCTION public.inbox_read_channel_directory(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_read_channel_directory(uuid) TO service_role;

-- Unknown history remains attached only to the CRM parent; never assign it
-- from current connection metadata. Legacy CRM count is NOT additive to known.
CREATE FUNCTION public.inbox_read_thread_rows(p_account uuid,p_scope text,p_channel uuid,p_parent uuid,p_connection uuid,p_status text,p_search text)
RETURNS TABLE(row_id uuid,sort_at timestamptz,payload jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT t.id,t.last_message_at,jsonb_build_object(
 'id',t.id,'conversation_id',t.conversation_id,'channel_id',t.channel_id,'provider',t.provider,
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
REVOKE ALL ON FUNCTION public.inbox_read_thread_rows(uuid,text,uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_read_thread_rows(uuid,text,uuid,uuid,uuid,text,text) TO service_role;

CREATE FUNCTION public.inbox_read_page(p_account uuid,p_actor uuid,p_op text,p_scope text,p_channel uuid,p_parent uuid,p_thread uuid,p_connection uuid,p_status text,p_search text,p_limit integer,p_before_at timestamptz,p_before_id uuid,p_message uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; v_parent uuid; v_scope text; v_channel uuid; v_highwater bigint; v_watermark bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE user_id=p_actor AND account_id=p_account AND account_role IN ('owner','admin','agent','viewer')) THEN
  RAISE EXCEPTION 'INBOX_READ_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 IF p_op IS NULL OR p_op NOT IN ('channels','connections','threads','history','resolve','counts','observations')
 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_scope IS NULL OR p_scope NOT IN ('active','historical','unknown','all')
 OR (p_scope='all' AND p_op NOT IN ('resolve','counts','connections','channels'))
 OR (p_scope='unknown' AND (p_channel IS NOT NULL OR p_op IN ('channels','observations')))
 OR (p_op IN ('channels','connections','observations') AND p_before_id IS NOT NULL AND p_before_at IS NULL)
 OR (p_op='observations' AND (p_thread IS NULL OR p_message IS NULL))
 OR (p_op<>'observations' AND p_message IS NOT NULL)
 OR (p_op NOT IN ('history','observations') AND p_thread IS NOT NULL)
 OR (p_op NOT IN ('resolve','history') AND p_parent IS NOT NULL)
 OR (p_op<>'resolve' AND p_connection IS NOT NULL)
 OR (p_op NOT IN ('threads','counts') AND (p_status IS NOT NULL OR p_search IS NOT NULL))
 OR (p_op='counts' AND p_before_id IS NOT NULL)
 OR (p_op='resolve' AND (p_scope<>'all' OR p_channel IS NOT NULL))
 OR (p_status IS NOT NULL AND p_status NOT IN ('open','pending','closed'))
 OR length(coalesce(p_search,''))>120 OR (p_before_id IS NULL AND p_before_at IS NOT NULL)
 THEN RAISE EXCEPTION 'INBOX_READ_INVALID' USING ERRCODE='22023'; END IF;
 IF p_channel IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.whatsapp_channels WHERE account_id=p_account AND id=p_channel) THEN RETURN NULL; END IF;
 IF p_connection IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.whatsapp_connections WHERE account_id=p_account AND id=p_connection) THEN RETURN NULL; END IF;
 IF p_parent IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.conversations WHERE account_id=p_account AND id=p_parent) THEN RETURN NULL; END IF;
 IF p_op IN ('history','observations') THEN
  IF p_scope='unknown' THEN
   IF p_thread IS NOT NULL OR p_parent IS NULL OR NOT EXISTS(SELECT 1 FROM public.inbox_read_thread_rows(p_account,'unknown',NULL,p_parent,NULL,NULL,NULL)) THEN RETURN NULL; END IF;
   v_parent=p_parent;
  ELSE
   SELECT t.conversation_id,t.channel_id,CASE WHEN d.ready THEN 'active' ELSE 'historical' END,t.ingest_highwater,t.read_watermark INTO v_parent,v_channel,v_scope,v_highwater,v_watermark
   FROM public.inbox_threads t JOIN public.inbox_read_channel_directory(p_account) d ON d.id=t.channel_id AND d.provider=t.provider
   WHERE t.account_id=p_account AND t.id=p_thread;
   IF NOT FOUND OR v_scope<>p_scope OR p_parent IS NOT NULL OR (p_channel IS NOT NULL AND p_channel<>v_channel) THEN RETURN NULL; END IF;
  END IF;
  IF p_op='observations' THEN
   -- Only canonical observations of a source in this authorized thread.
   -- No native identifiers, session snapshots, event IDs, raw payloads or
   -- receipt tokens. Historical and active diagnostics are read-only.
   IF NOT EXISTS(SELECT 1 FROM public.inbox_message_memberships im WHERE im.account_id=p_account AND im.thread_id=p_thread AND im.channel_id=v_channel AND im.message_id=p_message) THEN RETURN NULL; END IF;
   WITH page AS (
    SELECT o.id row_id,o.observed_at sort_at,jsonb_build_object('id',o.id,'connection_id',o.connection_id,'display_name',w.display_name,'direction',o.direction,'observed_at',o.observed_at) payload
    FROM public.inbox_message_memberships im JOIN public.inbox_canonical_messages cm ON cm.account_id=im.account_id AND cm.channel_id=im.channel_id AND cm.source_message_id=im.message_id
    JOIN public.inbox_message_connection_observations o ON o.account_id=cm.account_id AND o.channel_id=cm.channel_id AND o.canonical_id=cm.id
    JOIN public.whatsapp_connections w ON w.account_id=o.account_id AND w.provider=o.provider AND w.id=o.connection_id
    WHERE im.account_id=p_account AND im.thread_id=p_thread AND im.message_id=p_message AND im.channel_id=v_channel
    AND (p_before_id IS NULL OR (o.observed_at,o.id)<(p_before_at,p_before_id))
    ORDER BY sort_at DESC,row_id DESC LIMIT p_limit+1
   ) SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY sort_at DESC,row_id DESC),'[]'::jsonb) INTO result FROM page;
   RETURN jsonb_build_object('rows',result,'read_only',true);
  END IF;
  WITH page AS (
   SELECT m.id row_id,m.created_at sort_at,jsonb_build_object('id',m.id,'conversation_id',m.conversation_id,'channel_id',v_channel,
    'provider',CASE WHEN p_scope='unknown' THEN NULL ELSE im.provider END,'origin_connection_id',CASE WHEN p_scope='unknown' THEN NULL ELSE im.connection_id END,
    'sender_type',m.sender_type,'content_type',m.content_type,'content_text',m.content_text,'media_type',m.media_type,
    'has_media',m.media_url IS NOT NULL,'media_url',CASE WHEN m.media_url ~ ('^https://[a-zA-Z0-9.-]+/storage/v1/object/public/(chat-media|flow-media)/account-'||p_account::text||'/[A-Za-z0-9_./-]+$') AND m.media_url NOT LIKE '%/../%' AND m.media_url NOT LIKE '%/./%' THEN m.media_url END,
    'status',m.status,'created_at',m.created_at,'ingest_sequence',im.ingest_sequence::text,
    'reply_to_message_id',CASE WHEN EXISTS(SELECT 1 FROM public.messages rm LEFT JOIN public.inbox_message_memberships rim ON rim.message_id=rm.id AND rim.account_id=p_account WHERE rm.id=m.reply_to_message_id AND rm.conversation_id=v_parent AND ((p_scope='unknown' AND rim.message_id IS NULL) OR (p_scope<>'unknown' AND rim.thread_id=p_thread))) THEN m.reply_to_message_id END) payload
   FROM public.messages m LEFT JOIN public.inbox_message_memberships im ON im.message_id=m.id AND im.account_id=p_account AND im.conversation_id=m.conversation_id
   WHERE m.conversation_id=v_parent AND ((p_scope='unknown' AND im.message_id IS NULL) OR (p_scope<>'unknown' AND im.thread_id=p_thread AND im.channel_id=v_channel AND im.provider=m.provider AND im.connection_id=m.connection_id))
   AND (p_before_id IS NULL OR (p_before_at IS NOT NULL AND (m.created_at<p_before_at OR m.created_at IS NULL)) OR (m.created_at IS NOT DISTINCT FROM p_before_at AND m.id<p_before_id))
   ORDER BY m.created_at DESC NULLS LAST,m.id DESC LIMIT p_limit+1
  ) SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY sort_at DESC NULLS LAST,row_id DESC),'[]'::jsonb) INTO result FROM page;
  RETURN jsonb_build_object('rows',result,'read_only',true,'scope',p_scope,'channel_id',v_channel,'conversation_id',v_parent,'observed_highwater',v_highwater::text,'read_watermark',v_watermark::text);
 END IF;
 IF p_op IN ('threads','resolve') THEN
  IF p_op='resolve' AND p_parent IS NULL THEN RAISE EXCEPTION 'INBOX_PARENT_REQUIRED' USING ERRCODE='22023'; END IF;
  WITH page AS (SELECT * FROM public.inbox_read_thread_rows(p_account,p_scope,p_channel,p_parent,p_connection,p_status,p_search) r
   WHERE p_before_id IS NULL OR (p_before_at IS NOT NULL AND (r.sort_at<p_before_at OR r.sort_at IS NULL)) OR (r.sort_at IS NOT DISTINCT FROM p_before_at AND r.row_id<p_before_id)
   ORDER BY sort_at DESC NULLS LAST,row_id DESC LIMIT p_limit+1)
  SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY sort_at DESC NULLS LAST,row_id DESC),'[]'::jsonb) INTO result FROM page;
  RETURN jsonb_build_object('rows',result,'read_only',true);
 END IF;
 IF p_op='channels' THEN
  WITH page AS (SELECT d.id row_id,ch.created_at sort_at,jsonb_build_object('id',d.id,'provider',d.provider,'display_name',d.display_name,'own_phone',d.own_phone,
   'identity_state','verified','scope',CASE WHEN d.ready THEN 'active' ELSE 'historical' END,'ready',d.ready,'primary_connection_id',d.primary_connection_id,'ready_sessions',d.ready_sessions,
   'known_unread',coalesce((SELECT sum(t.unread_count_known) FROM public.inbox_threads t WHERE t.account_id=p_account AND t.channel_id=d.id),0),'read_only',true) payload
   FROM public.inbox_read_channel_directory(p_account) d JOIN public.whatsapp_channels ch ON ch.account_id=p_account AND ch.id=d.id
   WHERE (p_scope='all' OR (p_scope IN ('active','historical') AND d.ready=(p_scope='active'))) AND (p_channel IS NULL OR d.id=p_channel)
   AND (p_before_id IS NULL OR (ch.created_at,ch.id)<(p_before_at,p_before_id))
   ORDER BY sort_at DESC,row_id DESC LIMIT p_limit+1)
  SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY sort_at DESC,row_id DESC),'[]'::jsonb) INTO result FROM page;
  RETURN jsonb_build_object('rows',result,'read_only',true);
 END IF;
 IF p_op='connections' THEN
  WITH page AS (SELECT w.id row_id,w.created_at sort_at,jsonb_build_object('id',w.id,'display_name',w.display_name,'provider',w.provider,'status',w.status,
   'archived',w.archived_at IS NOT NULL,'channel_id',ep.channel_id,'identity_state',CASE WHEN ep.id IS NULL THEN 'unverified' ELSE 'verified' END,
   'membership_state',CASE WHEN ep.id IS NULL THEN 'unverified' WHEN ep.valid_until IS NULL THEN 'current' ELSE 'historical' END,
   'is_primary',coalesce(ep.is_primary,false),'ready',rs.connection_id IS NOT NULL,
   'registry_online',w.archived_at IS NULL AND ((w.provider='openwa' AND w.status IN ('ready','connected')) OR (w.provider='meta_cloud' AND w.status='connected')),'read_only',true) payload
   FROM public.whatsapp_connections w
   LEFT JOIN LATERAL (SELECT m.id,m.channel_id,m.valid_until,m.is_primary FROM public.whatsapp_channel_memberships m WHERE m.account_id=w.account_id AND m.connection_id=w.id AND m.provider=w.provider
    AND ((p_channel IS NULL AND m.valid_until IS NULL) OR (p_channel IS NOT NULL AND m.channel_id=p_channel))
    ORDER BY m.valid_until DESC NULLS FIRST,m.valid_from DESC,m.id DESC LIMIT 1) ep ON true
   LEFT JOIN public.inbox_read_ready_sessions(p_account) rs ON rs.channel_id=ep.channel_id AND rs.connection_id=w.id AND ep.valid_until IS NULL
   WHERE w.account_id=p_account AND (p_channel IS NULL OR ep.channel_id=p_channel)
   AND (p_scope='all' OR (p_scope='active' AND w.archived_at IS NULL AND w.status IN ('ready','connected') AND (p_channel IS NULL OR rs.connection_id IS NOT NULL))
    OR (p_scope='historical' AND (w.archived_at IS NOT NULL OR w.status NOT IN ('ready','connected') OR ep.valid_until IS NOT NULL))
    OR (p_scope='unknown' AND ep.id IS NULL))
   AND (p_before_id IS NULL OR (w.created_at,w.id)<(p_before_at,p_before_id))
   ORDER BY sort_at DESC,row_id DESC LIMIT p_limit+1)
  SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY sort_at DESC,row_id DESC),'[]'::jsonb) INTO result FROM page;
  RETURN jsonb_build_object('rows',result,'read_only',true);
 END IF;
 -- Counts are a same-statement snapshot. Global conservation is deliberately
 -- separate from selected lane counts and non-additive CRM unread.
 WITH inv AS (SELECT * FROM public.inbox_legacy_inventory(p_account)),
 lane AS (SELECT * FROM public.inbox_read_thread_rows(p_account,p_scope,p_channel,NULL,NULL,p_status,p_search)),
 counts AS (SELECT count(*) threads,coalesce(sum((payload->>'unread_count_known')::bigint),0) known_unread FROM lane),
 lane_messages AS (SELECT count(*) n FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id AND c.account_id=p_account
 LEFT JOIN public.inbox_message_memberships im ON im.message_id=m.id AND im.account_id=p_account AND im.conversation_id=m.conversation_id
 WHERE EXISTS(SELECT 1 FROM lane l WHERE (im.message_id IS NOT NULL AND l.payload->>'scope'<>'unknown' AND l.row_id=im.thread_id AND l.payload->>'channel_id'=im.channel_id::text AND im.provider=m.provider AND im.connection_id=m.connection_id) OR (im.message_id IS NULL AND l.payload->>'scope'='unknown' AND l.row_id=m.conversation_id)))
 SELECT jsonb_build_object('counts',jsonb_build_object('threads',counts.threads,'known_unread',counts.known_unread,'lane_messages',lane_messages.n,'scope',p_scope,'channel_id',p_channel,
 'source_messages',inv.source_messages,'associated_messages',inv.associated_messages,'unresolved_messages',inv.unresolved_messages,
 'legacy_crm_unread',inv.legacy_unread,'legacy_unread_is_additive',false),'read_only',true) INTO result FROM counts CROSS JOIN inv CROSS JOIN lane_messages;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.inbox_read_page(uuid,uuid,text,text,uuid,uuid,uuid,uuid,text,text,integer,timestamptz,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_read_page(uuid,uuid,text,text,uuid,uuid,uuid,uuid,text,text,integer,timestamptz,uuid,uuid) TO service_role;
