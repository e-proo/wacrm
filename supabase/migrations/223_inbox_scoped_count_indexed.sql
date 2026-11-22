-- INBOX-5 / SOF-80: performance-preserving count query rewrite.
-- Additive replacement of executable function only; prior migration 218 remains immutable.
-- No new role grants/RLS changes or client-facing data fields.
CREATE OR REPLACE FUNCTION public.inbox_read_filtered_page(p_account uuid,p_actor uuid,p_op text,p_scope text,p_channel uuid,p_status text,p_search text,p_unread boolean,p_assignment text,p_tags uuid[],p_company text,p_exact uuid,p_limit integer,p_before_at timestamptz,p_before_id uuid)
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
 lane_messages AS (
  -- Same exact semantics, but drive counts from the scoped thread list.
  -- Indexed per-thread memberships and per-conversation message timelines
  -- avoid scanning all account messages on every filtered counts request.
  SELECT coalesce(sum(scoped.n),0) n FROM (
   SELECT (SELECT count(*) FROM public.inbox_message_memberships im
    JOIN public.messages m ON m.id=im.message_id AND m.conversation_id=im.conversation_id
    WHERE im.account_id=p_account AND im.thread_id=l.row_id
    AND im.channel_id=(l.payload->>'channel_id')::uuid
    AND im.provider=m.provider AND im.connection_id=m.connection_id) AS n
   FROM lane l WHERE l.payload->>'scope'<>'unknown'
   UNION ALL
   SELECT (SELECT count(*) FROM public.messages m
    WHERE m.conversation_id=l.row_id AND NOT EXISTS(
      SELECT 1 FROM public.inbox_message_memberships im
      WHERE im.message_id=m.id AND im.account_id=p_account AND im.conversation_id=m.conversation_id)) AS n
   FROM lane l WHERE l.payload->>'scope'='unknown'
  ) scoped
 )
 SELECT jsonb_build_object('counts',jsonb_build_object('threads',counts.threads,'known_unread',counts.known_unread,'known_unread_threads',counts.known_unread_threads,
 'legacy_lane_unread',counts.legacy_lane_unread,'lane_messages',lane_messages.n,'scope',p_scope,'channel_id',p_channel,
 'source_messages',inv.source_messages,'associated_messages',inv.associated_messages,'unresolved_messages',inv.unresolved_messages,
 'legacy_crm_unread',inv.legacy_unread,'legacy_unread_is_additive',false),'read_only',true) INTO result FROM counts CROSS JOIN inv CROSS JOIN lane_messages;
 RETURN result;
END $$;
