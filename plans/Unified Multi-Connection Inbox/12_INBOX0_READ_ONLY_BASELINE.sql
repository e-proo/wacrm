-- INBOX-0 reproducible baseline: SELECT-only statements on TEST, never Production.
-- No individual account/phone/JID/message body or row IDs returned.
WITH base AS (
 SELECT m.conversation_id,m.connection_id,m.provider,m.sender_type,m.status,
 c.account_id,w.id AS registry_id,w.account_id AS registry_account,w.provider AS registry_provider,w.archived_at
 FROM public.messages m LEFT JOIN public.conversations c ON c.id=m.conversation_id
 LEFT JOIN public.whatsapp_connections w ON w.id=m.connection_id
), groups AS (
 SELECT conversation_id,
 count(DISTINCT connection_id) FILTER (WHERE registry_account=account_id AND registry_provider=provider) AS valid_connections,
 count(DISTINCT provider) AS providers,
 count(*) FILTER (WHERE connection_id IS NULL OR provider IS NULL OR registry_id IS NULL OR registry_account IS DISTINCT FROM account_id OR registry_provider IS DISTINCT FROM provider) AS unresolved
 FROM base GROUP BY conversation_id
)
SELECT (SELECT count(*) FROM public.accounts) accounts,(SELECT count(*) FROM public.contacts) contacts,
 (SELECT count(*) FROM public.conversations) conversations,(SELECT count(*) FROM base) messages,
 (SELECT count(*) FROM groups WHERE valid_connections>1) multi_connection_conversations,
 (SELECT count(*) FROM groups WHERE providers>1) multi_provider_conversations,
 (SELECT count(*) FROM groups WHERE unresolved>0) conversations_with_unresolved,
 (SELECT count(*) FROM base WHERE connection_id IS NULL) null_connection_messages,
 (SELECT count(*) FROM base WHERE provider IS NULL) null_provider_messages,
 (SELECT count(*) FROM base WHERE connection_id IS NOT NULL AND registry_id IS NULL) missing_registry,
 (SELECT count(*) FROM base WHERE registry_id IS NOT NULL AND registry_account IS DISTINCT FROM account_id) tenant_mismatch,
 (SELECT count(*) FROM base WHERE registry_id IS NOT NULL AND registry_provider IS DISTINCT FROM provider) provider_mismatch,
 (SELECT count(*) FROM base WHERE archived_at IS NOT NULL) archived_messages,
 (SELECT count(*) FROM public.conversations c WHERE NOT EXISTS(SELECT 1 FROM base b WHERE b.conversation_id=c.id)) empty_conversations,
 (SELECT count(*) FROM public.conversations WHERE unread_count>0) unread_conversations,
 (SELECT coalesce(sum(unread_count),0) FROM public.conversations) legacy_unread_total,
 (SELECT count(*) FROM base WHERE status='sending') sending_messages;
WITH g AS (
 SELECT m.conversation_id,m.connection_id,m.provider,w.archived_at,w.status,count(*) n,
 count(*) FILTER(WHERE m.sender_type='customer') inbound
 FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id
 JOIN public.whatsapp_connections w ON w.id=m.connection_id AND w.account_id=c.account_id AND w.provider=m.provider
 GROUP BY 1,2,3,4,5
) SELECT provider,(archived_at IS NOT NULL) archived,status,count(*) threads,sum(n) messages,sum(inbound) inbound_messages,
 count(*) FILTER (WHERE inbound=0) outbound_only_threads FROM g GROUP BY 1,2,3 ORDER BY 1,2,3;
SELECT provider,status,(archived_at IS NOT NULL) archived,count(*) FROM public.whatsapp_connections GROUP BY 1,2,3 ORDER BY 1,2,3;
WITH g AS (
 SELECT c.id,c.unread_count,count(DISTINCT m.connection_id) n,count(*) FILTER(WHERE m.sender_type='customer') inbound
 FROM public.conversations c LEFT JOIN public.messages m ON m.conversation_id=c.id GROUP BY c.id,c.unread_count
) SELECT count(*) FILTER (WHERE n>1 AND unread_count>0) mixed_with_unread,
 coalesce(sum(unread_count) FILTER (WHERE n>1),0) mixed_unread,
 count(*) FILTER (WHERE n=1 AND unread_count>0) single_with_unread,
 coalesce(sum(unread_count) FILTER (WHERE n=1),0) single_unread,
 count(*) FILTER (WHERE unread_count>inbound) unread_exceeds_inbound,
 count(*) FILTER (WHERE n=0 AND unread_count>0) empty_unread,
 (SELECT count(*) FROM (SELECT conversation_id,message_id FROM public.messages WHERE message_id IS NOT NULL GROUP BY 1,2 HAVING count(*)>1) x) legacy_duplicate_ids,
 (SELECT count(*) FROM (SELECT connection_id,provider,provider_message_id FROM public.messages WHERE provider_message_id IS NOT NULL GROUP BY 1,2,3 HAVING count(*)>1) x) provider_duplicate_ids FROM g;
WITH grouped AS (SELECT conversation_id,connection_id,count(*) cnt FROM messages GROUP BY 1,2)
 SELECT count(*) expected_threads,sum(cnt) expected_messages,
 (SELECT count(*) FROM messages WHERE provider_message_id IS NULL) missing_provider_message_id,
 (SELECT count(*) FROM messages WHERE sender_type='customer' AND provider_message_id IS NULL) inbound_missing_provider_message_id,
 (SELECT count(*) FROM messages WHERE sender_type='customer' AND provider='openwa' AND provider_chat_id IS NULL) openwa_inbound_missing_native_id FROM grouped;
SELECT role,tablename,has_table_privilege(role,'public.'||tablename,'TRUNCATE') AS truncate_granted,
 has_table_privilege(role,'public.'||tablename,'SELECT') AS select_granted,
 (SELECT relrowsecurity FROM pg_class WHERE oid=('public.'||tablename)::regclass) AS rls
 FROM (VALUES('anon'),('authenticated')) r(role) CROSS JOIN (VALUES('conversations'),('messages'),('whatsapp_connections')) t(tablename);
SELECT to_regclass('public.whatsapp_openwa_policy_versions') IS NOT NULL policy_catalog,
 to_regclass('public.whatsapp_openwa_consent_state') IS NOT NULL consent_state,
 to_regclass('public.whatsapp_openwa_activation_state') IS NOT NULL activation_state,
 current_setting('server_version') postgres_version;
-- Optional one-shot timing for only this small read, NOT p95 or end-to-end API.
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT conversation_id,connection_id,max(created_at) FROM public.messages
 WHERE connection_id IS NOT NULL GROUP BY 1,2 ORDER BY max(created_at) DESC LIMIT 50;
