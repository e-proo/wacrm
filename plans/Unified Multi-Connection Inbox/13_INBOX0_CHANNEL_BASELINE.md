# INBOX-0 channel identity supplement — TEST read-only (2026-11-21)
Owner approved ADR-INBOX-002. HEAD 25208ed542b51caf349fe89b534b9d7b1d60fdce; CI 44936282982 completed/success. Source inspection: session-lifecycle.ts 85–148 updates phone_identity from authenticated provider status and checks session ID; initial create/start routes may set identity. No phone_identity_verified_at in live registry metadata query; no historical membership epoch established. Current OpenWA send-connections 37–82 uses latest inbound and same stored phone_identity; inbound 037 dedup by parent/message_id and skips ordinary fanout; webhook receipt unique per connection; inbound normalization line 148 falls back to envelope.eventId if native ID absent. This is not cross-session identity proof.
## SELECT-only aggregate evidence (no individual numbers, IDs, message content or credentials)
| Metric | TEST |
|---|---:|
| OpenWA connections | 27 |
| OpenWA connections with stored phone_identity | 11 |
| Distinct OpenWA stored phone identity groups | 1 |
| Group with >1 session | 1 |
| Nonarchived OpenWA connections with stored identity | 2 |
| Groups with >1 ready/connected nonarchived | 0 |
| Meta connection / with stored phone_identity | 1 / 0 |
| Cross-provider same stored identity groups | 0 (Meta field absent, no claim of different physical numbers) |
| Candidate conversation/channel groups (account,parent,provider,stored identity or isolated connection) | 20 |
| Candidate groups spanning >1 connection | 5 |
| Underlying messages | 725 |
| Messages without stored phone identity (Meta) | 272 |
| Same stored identity, cross-session duplicate native ID groups in messages | 0 (legacy 037 can discard second observation, NOT proof of no duplicate delivery) |
Historical 32 connection-scoped pairs remain factual, not proposed final thread count. 20 is candidate-only and not actual migrated result; no proof for historical epoch or identity membership. Archived data retained. Existing 82 unread and 16 mixed parent ambiguity must be reassessed by confirmed channel at cutover; if all underlying connections of parent map to same verified channel, preserve inherited legacy count; else leave mixed unallocated. No database changes, live sends or Production.
## Reproduce
```sql
SELECT provider,count(*) connections,count(*) FILTER(WHERE nullif(btrim(phone_identity),'') IS NOT NULL) with_identity,count(*) FILTER(WHERE archived_at IS NULL) nonarchived,count(*) FILTER(WHERE archived_at IS NULL AND nullif(btrim(phone_identity),'') IS NOT NULL) nonarchived_with_identity FROM public.whatsapp_connections GROUP BY provider;
WITH g AS (SELECT account_id,provider,phone_identity,count(*) connections,count(*) FILTER(WHERE archived_at IS NULL) active,count(*) FILTER(WHERE archived_at IS NULL AND status IN ('connected','ready')) ready FROM public.whatsapp_connections WHERE nullif(btrim(phone_identity),'') IS NOT NULL GROUP BY 1,2,3) SELECT provider,count(*) distinct_identity_groups,count(*) FILTER(WHERE connections>1) multisession_groups,count(*) FILTER(WHERE active>1) multi_nonarchived_groups,count(*) FILTER(WHERE ready>1) multi_ready_groups,max(connections) max_sessions FROM g GROUP BY provider;
WITH b AS (SELECT c.account_id,m.conversation_id,m.provider,m.connection_id,w.phone_identity FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id JOIN public.whatsapp_connections w ON w.id=m.connection_id AND w.account_id=c.account_id AND w.provider=m.provider),groups AS (SELECT account_id,conversation_id,provider,CASE WHEN nullif(btrim(phone_identity),'') IS NOT NULL THEN phone_identity ELSE connection_id::text END identity_candidate,count(DISTINCT connection_id) sessions,count(*) messages FROM b GROUP BY 1,2,3,4) SELECT count(*) candidate_threads,count(*) FILTER(WHERE sessions>1) multisession_candidate_threads,sum(messages) total_messages,(SELECT count(*) FROM b WHERE nullif(btrim(phone_identity),'') IS NULL) messages_without_stored_phone_identity FROM groups;
```
