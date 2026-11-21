-- Read-only conservation probe for SOF-83 after 217. Run only on TEST.
-- No data updates, provider calls or feature activation.
BEGIN;
DO $verify$
DECLARE a record; actor uuid; v jsonb; page jsonb; r jsonb; h jsonb; hrow jsonb; prev uuid; prev_at timestamptz; hist_prev uuid; hist_at timestamptz; parent uuid; found_ids uuid[]; lane_count bigint; count_db record; lane text; thread uuid; channel uuid;
BEGIN
 FOR a IN SELECT id FROM public.accounts LOOP
  SELECT user_id INTO actor FROM public.profiles WHERE account_id=a.id AND account_role IN ('owner','admin','agent','viewer') ORDER BY user_id LIMIT 1;
  IF actor IS NULL THEN RAISE EXCEPTION 'account without authorized profile'; END IF;
  SELECT * INTO count_db FROM public.inbox_legacy_inventory(a.id);
  v=public.inbox_read_page(a.id,actor,'counts','all',NULL,NULL,NULL,NULL,NULL,NULL,10,NULL,NULL);
  IF (v->'counts'->>'source_messages')::bigint<>count_db.source_messages OR (v->'counts'->>'associated_messages')::bigint<>count_db.associated_messages OR (v->'counts'->>'unresolved_messages')::bigint<>count_db.unresolved_messages OR (v->'counts'->>'lane_messages')::bigint<>count_db.source_messages THEN RAISE EXCEPTION 'inventory conservation'; END IF;
  found_ids=ARRAY[]::uuid[];lane_count=0;
  FOREACH lane IN ARRAY ARRAY['active','historical','unknown'] LOOP
   prev=NULL;prev_at=NULL;
   LOOP
    page=public.inbox_read_page(a.id,actor,'threads',lane,NULL,NULL,NULL,NULL,NULL,NULL,3,prev_at,prev);
    EXIT WHEN jsonb_array_length(page->'rows')=0;
    FOR r IN SELECT value FROM jsonb_array_elements(page->'rows') WITH ORDINALITY AS x(value,i) WHERE i<=3 LOOP
     lane_count=lane_count+1;
     parent=CASE WHEN lane='unknown' THEN (r->'payload'->>'conversation_id')::uuid END;
     thread=CASE WHEN lane<>'unknown' THEN (r->'payload'->>'id')::uuid END;
     channel=CASE WHEN lane<>'unknown' THEN (r->'payload'->>'channel_id')::uuid END;
     hist_prev=NULL;hist_at=NULL;
     LOOP
      h=public.inbox_read_page(a.id,actor,'history',lane,channel,parent,thread,NULL,NULL,NULL,17,hist_at,hist_prev);
      IF h IS NULL THEN RAISE EXCEPTION 'missing scoped history'; END IF;
      EXIT WHEN jsonb_array_length(h->'rows')=0;
      FOR hrow IN SELECT value FROM jsonb_array_elements(h->'rows') WITH ORDINALITY AS x(value,i) WHERE i<=17 LOOP
       hist_prev=(hrow->>'row_id')::uuid;hist_at=(hrow->>'sort_at')::timestamptz;
       IF hist_prev=ANY(found_ids) THEN RAISE EXCEPTION 'duplicate history cursor'; END IF;
       found_ids=array_append(found_ids,hist_prev);
      END LOOP;
      EXIT WHEN jsonb_array_length(h->'rows')<=17;
     END LOOP;
     prev=(r->>'row_id')::uuid;prev_at=(r->>'sort_at')::timestamptz;
    END LOOP;
    EXIT WHEN jsonb_array_length(page->'rows')<=3;
   END LOOP;
  END LOOP;
  IF cardinality(found_ids)<>count_db.source_messages OR EXISTS(SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id WHERE c.account_id=a.id AND NOT m.id=ANY(found_ids)) THEN RAISE EXCEPTION 'missing source in paginated API'; END IF;
 END LOOP;
END $verify$;
SELECT 'all source rows enumerated exactly once across active, historical and unknown lanes' verification,
 (SELECT count(*) FROM public.messages) source_messages,
 (SELECT count(*) FROM public.inbox_message_memberships) associated_messages,
 (SELECT count(*) FROM public.messages m WHERE NOT EXISTS(SELECT 1 FROM public.inbox_message_memberships im WHERE im.message_id=m.id)) unresolved_messages,
 (SELECT coalesce(sum(unread_count),0) FROM public.conversations) legacy_crm_unread,
 (SELECT count(*) FROM public.whatsapp_channels) verified_channels,
 (SELECT count(*) FROM public.conversations) crm_parents;
ROLLBACK;
