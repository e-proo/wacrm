# INBOX-5 — Scale, security, regression & reliability (SOF-73)
Depends INBOX-4. Implementation release gate.
## 5.1 Performance and reliability
- Measure baseline/target with synthetic account 10k threads / 100k messages (adjust to TEST resources, disclose actual size). Proposed budgets for ADR: list page 30–50 and history 50 messages, server p95 <500ms list/history on representative warm TEST, no N+1, no full message scans per list, bounded payload and realtime coalescing; record p50/p95, row counts and EXPLAIN (ANALYZE only safe read fixture). Measure cold separately, tune indexes/query and document environment rather than claim production SLA.
- Stable cursors across new messages/status changes; avoid duplicate/omitted pages under refresh. Load older history on demand, preserve scroll, bounded media/reaction fetching; concurrency between read/unread/ACK and realtime, account switch with outstanding request, reconnect, archived/deleted session, network timeout. Verify durable reconciliation and feature flag off/on, no orphan projection state.
### 5.2 Security and compatibility
- Recheck RLS, column grants, service_role explicit scopes, role matrix admin/agent/viewer/API key; invalid IDs/cursors/forged connection, unauthorized session read/refresh, attachment storage, no secret or provider-native identities leaked unnecessarily, no cross-account cache, redacted observability and audit. Review advisor delta and NOTE-001; never weaken policy.
- Regression matrix: inbound Meta/OpenWA/echo/identity, task platform freeze/coverage/promotion/worker scheduled paths, automations, flows, AI reply/draft, broadcast enqueue/worker/ACK, contact/deals/notes, public API v1/MCP, notifications/tags, read/reactions/templates; validate same customer with multi connection. Verify feature disabled preserves old contract.
- CI full lint/typecheck/tests/build plus migrations clean replay and dedicated transactional smoke; TEST apply/readback via ledger, RLS isolation and synthetic data cleanup. Observability: projection lag, mismatch, realtime resync, send error codes and unresolved/uncertain counts, alert thresholds agreed after measurement; no customer content/PII in logs.
## DoD
Runtime HEAD CI and migration CI success, TEST smoke with evidence, performance budget evaluated, no critical/high unaccepted defects, rollback tested and security findings recorded. Live acceptance not assumed.

## Gates مشتركة
- اقرأ HEAD والخطة ذات الصلة وAGENTS.md قبل التنفيذ؛ هذا المرجع مبني على 33e8e9af73d3de8c010ee291700fff7073abf520. التاريخ 2026-11-21.
- TEST فقط؛ لا تعديل Production ولا تشغيل إرسال حي بلا تفويض منفصل. لا تعديل migration قديمة، لا توسيع grants ولا تعطيل RLS أو guardrails لإمرار اختبار.
- سجل commit, CI run, migrations ledger, smoke output, risks, screenshots إن لزم. فرّق implementation complete / CI verified / TEST verified / live acceptance / production ready.
- لا إغلاق المهمة أو المرحلة قبل DoD المحدد؛ إذا كان CI قيد التشغيل فالبوابة مفتوحة.


## 2026-11-21 — Owner-approved channel identity amendment (normative)
[ADR-INBOX-002](14_INBOX0_CHANNEL_ADR.md) supersedes any earlier per-connection thread key or contradictory wording. Test simultaneous duplicate native events across sessions, distinct message IDs identical content, unknown aliases, cross-channel ID collision, identity epoch revocation/re-pair, archived/recreated session history, read cursor concurrency, canonical count and exactly-once logical fanout, frozen task and aggregate caps; measure observation volume and dedup lock contention.
