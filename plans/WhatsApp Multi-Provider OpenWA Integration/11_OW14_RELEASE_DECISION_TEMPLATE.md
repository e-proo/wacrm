# OW-14 — Release Evidence Manifest and Independent Go/No-Go Record

**Template only. No approvals, production actions or provider messages are authorized by this file.**
**Master plan:** 10_OW14_PRODUCTION_READINESS_AND_ROLLOUT_PLAN.md
**Status on 2026-11-12:** NO-GO / OW-12 and OW-13 acceptance deferred; NOTE-001 open.

## A. Release identity (complete at decision time)

| Field | Verified value / evidence |
| --- | --- |
| Release candidate version | PENDING |
| GitHub ref and immutable commit SHA | PENDING |
| Source tree / lockfile / artifact digest | PENDING |
| Exact CI run and jobs (completed/success) | PENDING |
| Clean replay + migrations workflow run | PENDING |
| Database TEST migration ledger and schema smoke | PENDING |
| Production migration list, impact and approval | NOT AUTHORIZED |
| WACRM hosting/origin and deployment target | PENDING |
| OpenWA gateway build/engine/Chromium versions | PENDING |
| Persistent session/profile storage and backup | PENDING |
| Owner, UTC start/end maintenance window | PENDING |
| Customer and tenant opt-in scope | NONE AUTHORIZED |
| Canary traffic and per-tenant quotas | NONE AUTHORIZED |
| Support contacts, on-call and rollback owner | PENDING |

## B. Immutable evidence gates

Each gate MUST include: PASS / FAIL / PENDING / N/A (with rationale), named independent reviewer, UTC date/time, and a stable link to reproducible evidence. A description or checkbox with no evidence is PENDING, not PASS.

| Gate | Acceptance test | Decision | Evidence link | Reviewer |
| --- | --- | --- | --- | --- |
| G0 HEAD and exact CI/replay | Immutable SHA; lint/typecheck/tests/build; replay and Meta regression green | PENDING | | |
| G1 OW-12 live TEST | Session/QR, inbound/outbound media/text/context, ack/read, retries/reconnects, reconciliation, tenants, workloads and Meta | PENDING | SOF-41 | |
| G2 OW-13 formal pilot | Written cohort/consent, bounded runtime and volume, incidents, stops, resources, reconciliations, signed exit report | PENDING | SOF-43 | |
| G3 deployment/capacity/restore | Isolated reproducible gateway, pinned engine, durable session profiles, capacity and recovery test | PENDING | | |
| G4 security and NOTE-001 | Scoped role/RLS, advisors review, secrets encryption/rotation, privacy, threat model, signed exception dispositions | PENDING | PROJECT_NOTES.md | |
| G5 observability/incident | Dashboard, alerts delivered, owner and backup, documented STOP drill | PENDING | | |
| G6 reliability/Meta parity | Signed webhook finalization, ack, dedup, native reconciliation or held unknown outcomes, no duplicate sends, Meta test | PENDING | | |
| G7 opt-in/UX/legal | Approved unofficial-integration warning, explicit tenant opt-in and customer support process | PENDING | | |
| G8 release governance | Signed independent GO and separate Production authorization with scope/time/window | NO-GO | | |
| G9 canary/stabilization | Approved waves and post-deploy monitoring/stop evidence | NOT STARTED | | |

**Hard veto / mandatory NO-GO:** cross-tenant or credential leak, confirmed unexplained duplicate physical send, irreversible session loss, missing rollback, unaccepted OW-12/13, unsafe Meta regression, material unreviewed NOTE-001 finding, unapproved unofficial-provider warning or incomplete operational owner/alerts. A conditional GO may authorize non-production rehearsal only. No production activation from conditional GO.

## C. Risk register

| Risk ID | Scope and evidence | Severity | Mitigation | Residual risk | Owner / approval | Status |
| --- | --- | --- | --- | --- | --- | --- |
| R-01 | Unofficial WhatsApp Web transport / restrictions | TBD | Product warning, opt-in, bounded traffic, emergency STOP | TBD | TBD | OPEN |
| R-02 | Native ambiguous outcomes / no blind resend | TBD | Reconciliation proof or operator hold, idempotency | TBD | TBD | OPEN |
| R-03 | Webhook 503 / long agent processing / dedup | TBD | Retry/lease and failure recovery verification | TBD | TBD | OPEN |
| R-04 | Session profile recovery and engine upgrades | TBD | Pinned images, encrypted backup, restore rehearsal | TBD | TBD | OPEN |
| R-05 | Supabase NOTE-001 security findings | TBD | Itemized remediation or independent security waiver | TBD | TBD | OPEN |
| R-06 | Tenant/session identity selection and Meta compatibility | TBD | Scoped routing and explicit provider choice, regression | TBD | TBD | OPEN |

## D. Capacity, quality and monitoring observations

Do not invent numbers. Populate from actual dated tests/pilot/canary:

- Number of opted-in accounts, sessions, user-consented recipients and inbound/outbound messages: PENDING
- Per-session uptime, restart/reconnect count and time to ready: PENDING
- Webhook latency p50/p95/p99, signed retry 503 rate, durable receipt completion: PENDING
- Provider sends/ACK/read, unknowns held, native correlation and confirmed duplicates: PENDING
- Media error rates, agent/automation/broadcast circuit events and Meta regression: PENDING
- Host CPU/RAM/disk, browser/session density, cost, RTO/RPO and backup/restore results: PENDING
- Rollback and STOP timestamps, audit and operator acknowledgment: PENDING
- Alert recipients, route and test-page delivery proof: PENDING

## E. Suggested rollout order (not authorized)

- R0: Production dark deploy; OpenWA disabled for all accounts; health and no-egress verification.
- R1: One approved internal opt-in account + non-critical number and consent.
- R2: Small explicitly approved customer opt-in cohort, independently reviewed.
- R3: Gradual expansion only on fresh measurements and signed wave approval.

For each wave record: owner, window UTC, exact SHA, approved tenant count, flags/limits, baseline metrics, stop triggers, final status, incident and audit links, approved next-wave decision. Never auto-failover from Meta, silently expand or resend unknown messages.

## F. Emergency stop and rollback card

1. Identify affected account/connection/transport by scoped, redacted telemetry.
2. Block further affected OpenWA dispatch through authenticated operator stop/feature admission; suspend associated WACRM automation/agents/broadcast work as appropriate. Preserve Meta default and unaffected accounts.
3. Capture immutable incident timestamps, provider-native evidence, message keys, status receipts, guardrail decisions and resource data WITHOUT personal data or secrets.
4. Classify each ambiguous send as UNKNOWN unless verified native evidence establishes outcome; DO NOT blind resend or infer failure from timeout.
5. Roll back service artifact/image via tested compatibility only; preserve durable WhatsApp session profiles, encrypted keys and database audit. Recover/re-QR under authorized process if needed. Do not reverse applied migrations.
6. Confirm metrics/tenant isolation/Meta baseline; file incident report; require explicit fresh release authorization before resuming.

## G. Signed release decision

**Decision (choose exactly one):** NO-GO / CONDITIONAL GO FOR NON-PRODUCTION PREP ONLY / GO FOR DEFINED PRODUCTION WAVE  
**Current decision:** NO-GO (planning checkpoint; no signatures)  
**Authorized release owner:** PENDING  
**Engineering reviewer:** PENDING  
**Security reviewer (including NOTE-001):** PENDING  
**SRE/on-call owner and backup:** PENDING  
**QA/OW-12 and Pilot/OW-13 owner:** PENDING  
**Product/Legal consent and warning owner:** PENDING  
**Decision UTC timestamp and exact SHA:** PENDING  
**Production change ticket, exact scope and start/end:** NOT AUTHORIZED  
**Specific risk exceptions, expiry, mitigation, reapproval:** NONE RECORDED  
**Final status:** NOT PRODUCTION READY

To close OW-14, attach final GitHub release manifest, CI/Migrations/TEST and live provider evidence, formal pilot report, security/ops approvals, each canary wave report and stabilization decision. Keep Linear milestone and PROJECT_NOTES.md consistent with evidence.
