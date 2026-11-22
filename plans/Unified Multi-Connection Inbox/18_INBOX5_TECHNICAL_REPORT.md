# INBOX-5 — Technical performance, security and reliability evidence

Date: 2026-11-22 · source-of-truth `e-proo/wacrm` / `refactor/service-platform-v2`.
Scope: SOF-80 (5.01) and SOF-87 (5.02). This is **engineering/TEST** evidence; not live acceptance, GA or a production SLA.

## Implementation and rollback

- `222_inbox_health_observability.sql`: 3 narrow account/state and recent-membership indexes; SECURITY INVOKER `public.inbox_health_snapshot(account,actor)`, explicit owner/admin membership and SERVICE_ROLE-only execute; no native IDs, phone numbers, message bodies, tokens or PII in results. HTTP `GET /api/inbox/health` additionally requires authenticated admin, exact account/actor headers, TEST project, `WACRM_INBOX_READ_API=test_only`, and 12 requests/min; it has no write path.
- `223_inbox_scoped_count_indexed.sql`: additive `CREATE OR REPLACE` of `public.inbox_read_filtered_page`, retaining result type, grants, RLS, feature flags and semantics. Lane-message count now drives via indexed scoped thread membership/conversation rather than an all-account messages join. Migration 218 remains unchanged.
- **Immediate feature rollback:** set `WACRM_INBOX_READ_API=off` to stop new read/health API; set `WACRM_INBOX_SCOPED_UI=off` to stop new UI; separately keep `WACRM_INBOX_ACTIONS=off` to deny new sends. These controls never delete pending/uncertain identities; read-only evidence and exact-key reconciliation must be preserved where authorized. Schema rollback requires a reviewed compensating migration or restoration, **not rewriting already applied migrations**. The CI security and benchmark fixtures are transactional and rolled back after their assertions; this is not equivalent to a production schema rollback exercise.
- No provider sends, pilot/cap edits, production writes or account context leakage. Existing Meta official default, OpenWA optional adapter, task/flow/broadcast frozen connection and signed echo pipeline preserved.

## Synthetic query performance — measured, not extrapolated

Source: [Migrations CI #45047399992](https://github.com/e-proo/wacrm/actions/runs/45047399992), `supabase/ci/inbox5-synthetic-benchmark.sql`. Clean local Postgres, `CREATE TEMP TABLE`/rollback; **10,000 synthetic threads**, **100,000 synthetic messages**. A skewed workload puts 50 messages in each of 1,000 active threads and the remaining 50,000 across 9,000 threads. B-tree indexes match the relevant account+cursor and thread+timeline key shapes. No customer data.

| Synthetic page | Samples | p50 SQL only | p95 SQL only | EXPLAIN ANALYZE | Observed rows |
|---|---:|---:|---:|---:|---:|
| Thread list (limit 31) | 35 | 0.019 ms | 0.034 ms | 0.050 ms | 31 |
| Thread history (limit 51) | 35 | 0.022 ms | 0.037 ms | 0.042 ms | 50 |

Both measured p95 values satisfy the **provisional synthetic SQL-only** 500ms diagnostic threshold. These are low-level temp indexed query measurements, **not** full `inbox_read_filtered_page` 10k/100k results, HTTP p95, real provider traffic, workload locking or production capacity certification. Query plan shows index-only scan and bounded rows; load/CPU/network and cold cache are excluded. Do not quote these as external production SLAs.

Hosted Supabase TEST, read-only actual `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)` on `inbox_read_filtered_page` with zero scoped threads measured **11.723 ms** after 223. An earlier cold pre-223 sample measured **141.871 ms**; cache/compilation conditions differ, so it is invalid to claim a 12x improvement or a stable hosted p95 from them. TEST currently has **0 active verified memberships, 0 scoped threads and 0 explicit action intents**. Representative hosted 10k/100k warm p95 and N-sessions native lock throughput are unmeasured, to be addressed before GA if capacity target becomes mandatory.

## Security/compatibility matrix

[Clean migration replay and regression #45047399992](https://github.com/e-proo/wacrm/actions/runs/45047399992) includes all prior SQL smokes and the new `inbox5-security-regression-smoke.sql`. New rollback-only security test proves health RPC deny to anon/authenticated and agent/viewer/foreign account, admin-only payload, continued action journal RLS, source guard, no browser claim and redaction. Hosted TEST after migrations 222/223: expected service RPC `true`, browser RPC `false`, RLS `true`. Supabase advisors show only existing NOTE-001 `auth_leaked_password_protection` warning (no new critical/high from this work).

- **A29/A30:** repeated native webhook and two competing sessions sharing a canonical native identity — `inbox-canonical-observation-smoke.sql`, `inbox-canonical-concurrency-smoke.sh`; exactly-once logical source/unread/effect.
- **A31/A32:** distinct native IDs and ambiguous aliases fail closed to review — observation, source, deferred and native-identity smokes.
- **A33/A34:** membership epoch revocation/re-pair, provider/channel collision, immutable original sender — `inbox-provider-policy-smoke.sql`, `inbox-canonical-primary-smoke.sql`, `inbox-canonical-outbound-smoke.sql`.
- **A35:** aggregate OpenWA same-channel cap across primary/secondary; no independent bypass — `inbox-provider-policy-smoke.sql`; provider guardrail/pilot regression.
- **Outbound, worker and CRM compatibility:** full Vitest CI retains `inbox/canonical-route-context.test.ts`, `inbox/scoped-read-action.test.ts`, `inbox/scoped-action-route.test.ts`, `whatsapp/transport/router.test.ts`, `whatsapp/send-message.test.ts`, `whatsapp/broadcast-worker.test.ts`, `ai/tasks/outbound-connection.test.ts`, `flows/engine.test.ts`, `automations/engine.test.ts`, notification/read and API tests. Existing worker connection freeze is not modified by this phase. Verification is at mock/unit/integration+SQL level, not Meta/OpenWA provider live delivery.

## Observability semantics and operational limits

Health JSON includes only: total scoped threads/active memberships, uncertain actions, pending actions older than 5m, claimed effects older than 5m, effect review/pending/awaiting-source counts, recent 24h projected message count and recent orphan memberships. Non-zero orphan is a projection-mismatch alert candidate; uncertain/review >0 requires reconciliation; pending/claimed older than 5m needs backlog investigation. **These are proposed diagnostics, not approved paging thresholds.** Realtime reconnect is shown separately in the client and recovered by bounded coalescing + 20s polling; client events are not durably counted by this server aggregate. Native send error-code breakdown and precise end-to-end projection-lag durations are not asserted to exist unless separately instrumented.

No alert notification is sent automatically by this phase; support/operations must review metrics and configure external monitoring before rollout.

## Open acceptance and release gates

- [SOF-90](https://linear.app/eproo/issue/SOF-90): desktop/mobile visual TEST review (owner intentionally deferred); INBOX-4 parent pending.
- [SOF-81](https://linear.app/eproo/issue/SOF-81): authorized live TEST two-provider acceptance; none performed for INBOX-5.
- [SOF-87](https://linear.app/eproo/issue/SOF-87): hosted TEST transaction-positive fixture had previously been blocked by platform safety in SOF-78; isolated clean migration replay supplies positive transactional evidence but is **not** hosted live acceptance.
- NOTE-001 leaked-password protection remains open as an external pre-GA advisor finding.
- Production ready/GA is **not** claimed by this report.
