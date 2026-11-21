# INBOX-0 — Read-only baseline and evidence (SOF-68 / SOF-75)
Date: 2026-11-21. Branch `refactor/service-platform-v2`. Verified starting HEAD [0fd459f92ac67ba1f87eb2a2fffc9437976b60d1](https://github.com/e-proo/wacrm/commit/0fd459f92ac67ba1f87eb2a2fffc9437976b60d1), documentation-only plan on runtime baseline 33e8e9a. [CI 44934468766](https://github.com/e-proo/wacrm/actions/runs/44934468766) completed/success on starting HEAD; earlier [44800636849](https://github.com/e-proo/wacrm/actions/runs/44800636849) completed/success for runtime. Source tree 1,524 blobs (1,515 before planned docs). Read-only source review of named direct/indirect boundaries in [dependency inventory](10_INBOX0_DEPENDENCY_INVENTORY.md); not a complete machine-grep of every file. No credentials, customer numbers, text, native JIDs or row IDs recorded. No provider dispatch, role impersonation, mutation, migration apply or Production access.

## Actual TEST aggregates
Supabase project `wacrm test`, ref pqirsnfupofhulmewakq, ACTIVE_HEALTHY; PostgreSQL 17.11. Point-in-time SELECT snapshots, not a claim that current running app equals Git HEAD. Worker traffic can change numbers. Recheck at migration cutover in one consistent snapshot. 
| Metric | Observed |
|---|---:|
| accounts / contacts / conversations | 1 / 20 / 20 |
| messages | 725 |
| conversations with at least 1 message / empty | 19 / 1 |
| conversation+connection pairs | 32 |
| multiple connections / multiple providers | 5 / 1 |
| unresolved by null/mismatch scoped registry | 0 |
| null connection / null provider / missing registry / tenant mismatch / provider mismatch | 0 / 0 / 0 / 0 / 0 |
| messages with archived connection | 117 |
| provider-native message ID null / inbound ID null | 45 / 0 |
| OpenWA inbound native chat ID null | 2 |
| status sending | 1 |
| duplicate non-null conversation+message_id / provider+connection+provider_message_id groups | 0 / 0 |
| conversations with unread / total legacy unread | 11 / 82 |
| mixed conversations with unread / their unread | 3 / 16 |
| single connection conversations with unread / their unread | 8 / 66 |
| unread > inbound count / empty with unread | 0 / 0 |

| Provider & registry snapshot state | Threads | Messages | Inbound |
|---|---:|---:|---:|
| Meta connected, not archived | 3 | 272 | 156 |
| OpenWA ready, not archived | 10 | 213 | 95 |
| OpenWA logged_out, not archived | 7 | 123 | 50 |
| OpenWA disconnected, archived | 2 | 10 | 5 |
| OpenWA ready, archived | 10 | 107 | 60 |
| Total | 32 | 725 | 366 |

One outbound-only thread (OpenWA ready); it must not default to Meta due to lack of inbound. 45 missing provider message IDs do not imply a missing connection or failed delivery. Do not fabricate identity/status/read receipts; 2 missing native inbound JIDs require normal verified recipient resolution, not inference. One sending row remains untouched. Registry: Meta connected 1; OpenWA nonarchived ready 1, logged_out 1; archived 25 (disconnected 1, failed 14, logged_out 1, ready 7, waiting_qr 2). Archived flag overrides status, and ready is not permission to send. Active default list: 13 threads / 485 messages at snapshot; current rows do not prove live gateway reachability. Historical/unavailable: 19 threads / 240 messages in observed snapshot. Empty parent is separate CRM history, no fabricated connection. 
Unread: no per-connection read marker in existing schema. 66 may be preserved as historical single-connection count, not reconstructed exact message read identities. 16 mixed-parent unread are indeterminate; preserve separately as unallocated legacy count, no distribution by guess, no silent reset. ADR specifies algorithm.

## Actual relational/index/role evidence
- `idx_conversations_account_contact` unique(account_id,contact_id), existing unique(account_id,id) index `conversations_account_id_id_uidx`. Registry unique(account_id,id) `whatsapp_connections_account_id_transport_uidx`. Use composite FK candidates; verify exact constraints and full provider identity immutability before adding constraints.
- messages: unique(conversation_id,message_id) legacy 037, unique(provider,connection_id,provider_message_id) partial, unique(conversation_id,outbound_idempotency_key) partial, unique(ai_agent_run_id) partial, unique(engine_idempotency_key) partial; index conversation and connection/created plus OpenWA inbound native lookup. No observed collision; keep legacy index now, require regression/explicit migration if collision demonstrated.
- Existing FKs to conversations include messages, message_reactions, deals, flow_runs, notifications, AI runs/usage/state/task targets/coverage negotiation, business_event_outbox, customer_intents/notifications, exchange_trade_requests. Existing message and connection FKs also anchor task outbound, ACK/operator reviews, reply_to, broadcast recipients/workers, deferred events, credential/guardrail/audit records. Splitting or repointing breaks these contracts.
- Existing RLS enabled; policies authorize reads by parent current account membership and writes by agent (conversations/messages) or admin (registry). Existing message policy is scoped to conversation and not independently to message connection, and broad role grants remain. Trigger `messages_openwa_chat_identity_server_only` guards native identity on insert/update; it is not universal proof of provider provenance.
- **SEC-INBOX-01 (release blocker, verify/remediate before new write/read policy activation):** metadata confirmed effective `has_table_privilege` SELECT and TRUNCATE true for both anon and authenticated on conversations, messages and whatsapp_connections; table grants include INSERT/UPDATE/DELETE/TRIGGER/REFERENCES. RLS is enabled but SQL TRUNCATE is not constrained by row policies. REST reachability of TRUNCATE is not established; no destructive test performed. Review least privilege and revoke unnecessary SQL privileges through an additive migration after caller census, plus transactional role negatives. Inspect grants on provider_chat_id, provider, connection_id, sender_type, created_at, provider_message_id and registry metadata/session identity: existing column privilege introspection reports SELECT/INSERT/UPDATE from broad table grants. Do not expose them in new API. In particular never trust client-created customer rows/timestamps as a Meta window proof. Harden durable server-authored message provenance and protect immutable route/time in INBOX-1; new write/read APIs must not allow bypass through old direct browser writes. Existing role policy/trigger scope must be tested with synthetic fixtures. No grants changed during audit.
- Supabase security advisor independently returned only `auth_leaked_password_protection=1` (WARN); not a substitute for explicit grant inspection. NOTE-001 open; [remediation](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). Do not claim security fixed.

## Migration and cross-track evidence
Ledger 133 records at inspection; tail includes 198 at 20261118030014, 199 20261119151254, 200 20261119151312, 201 20261119151318, 202 ACK disposition 20261120002307, 203 audit append-only grants 20261120002434. Highest numbered source migration 204_openwa_operational_consent_activation.sql is in HEAD but no ledger entry found; `to_regclass` confirms whatsapp_openwa_policy_versions / consent_state / activation_state absent in TEST. **DEP-INBOX-01:** coordinate SOF-54/W07 and verify migration 204 and enforce_test (when authorized) before asserting consent/activation readiness, live acceptance or enabling the new write surface. Legacy TEST branch of gate is not proof of activation. Do not apply 204 here or bypass gate. Actual running TEST build / W07 env flag not verified. Linear SOF-41,51,52,54,66,24 In Progress; SOF-50 Todo. Related dependencies not closed by Inbox. Latest security and CI checks at actual runtime release required.
 
## Performance / UX baseline
Existing UI code: conversation list fetches all account conversations by last_message_at, filters in memory; thread fetches all messages by parent, direct unread reset, subscription parent-wide, responsive list/thread and desktop contact panel; Meta-only connectivity check and universal 24h timer. Real browser/screenshot and running build not available (browser connector reported originating browser context required). Static review only. SELECT EXPLAIN ANALYZE grouping verified pairs (LIMIT 50 on 725 rows) returned 32 rows, planning 0.929 ms, execution 0.606 ms on TEST; this is one small DB read measurement, not API latency or p95. Synthetic 10k threads/100k messages + p95 target <500 ms warm API list/history in INBOX-5, record environment/p50/p95 separately; no fixture writes in this phase. 
Reproducible SELECT-only aggregates: [baseline SQL](12_INBOX0_READ_ONLY_BASELINE.sql).

## Gate status
Actual read-only TEST baseline and technical ADR prepared. No runtime implementation, schema changes, synthetic role tests, load test, live acceptance or production readiness. Full branch-wide static reader/writer grep is still required to prove census completeness (connector exact path reads, local clone unavailable); UI baseline screenshot conditional and missing. SOF-68/SOF-75 stay In Review until exhaustive source census/ADR review is evidenced. SOF-82 ADR is technically approved for implementation design, pending phase gate; do not activate sender/read surfaces until security and deployment prerequisites. 
