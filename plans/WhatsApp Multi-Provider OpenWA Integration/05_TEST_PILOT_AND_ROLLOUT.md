# OW-12 / OW-13 / OW-14 — Live TEST, Bounded Pilot, Production Rollout

## OW-12 — Live TEST Acceptance

Use a dedicated/non-critical WhatsApp number. Record evidence, timestamps, connection/provider IDs (redacted where sensitive), CI run and migration state.

### Acceptance scenarios
- create session and scan QR
- ready state after authentication
- inbound/outbound text
- swipe reply/context
- image/video/audio/document as supported by MVP
- delivery/read status where emitted
- disconnect/reconnect
- WACRM restart while session remains/reconnects correctly
- OpenWA restart/session recovery
- duplicate webhook delivery
- outbound ambiguous timeout/reconciliation
- restriction/logged-out simulation or safe provider event fixture where real restriction cannot be induced
- automation send
- agent send
- bounded broadcast
- cross-tenant negative tests
- Meta connection regression on same TEST environment

### Gate
No production pilot if there is unexplained duplicate send, cross-tenant exposure, credential/QR leak, unrecoverable session loss, or Meta regression.

---

## OW-13 — Bounded Pilot

### Scope
Small allowlisted tenant/number cohort only. OpenWA is feature-flagged and opt-in. Meta remains default/recommended production path.

### Observe
- session uptime/reconnect frequency
- provider error/restriction rate
- duplicate/reconciliation rate
- inbound webhook latency/failures
- outbound success/ack latency
- media failures
- automation/broadcast circuit breakers
- resource consumption per OpenWA session/engine

### Stop conditions
Immediately pause new OpenWA sends for affected connection/pool on restriction signals, repeated ambiguous sends, material duplicate rate, tenant isolation concern, credential exposure, uncontrolled reconnect loop, or material WhatsApp account risk.

### Exit evidence
Pilot report with cohort, duration, send volume, incidents, reconciliations, restrictions, resource profile, rollback exercises and unresolved risks.

---

## OW-14 — Production Rollout Decision

Production readiness is an explicit decision, not the automatic consequence of code completion.

### Required evidence
- OW-0..OW-13 gates passed
- branch-wide CI green
- migrations clean replay green
- TEST live acceptance recorded
- bounded pilot accepted
- monitoring/alerts/runbook/rollback documented
- capacity plan for OpenWA instances/session placement
- secrets rotation and incident process documented
- customer-facing unofficial-integration warning approved
- Meta regression suite green
- current `PROJECT_NOTES.md` reviewed
- `NOTE-001` Supabase project-wide security debt explicitly reviewed for GA impact; production approval must record whether it is resolved or accepted by a separate security decision

### Rollout
Use allowlist/feature flag first, then staged cohort expansion. Maintain emergency provider/connection disable controls. Do not auto-failover between Meta and OpenWA for the same customer identity unless a later design explicitly proves identity, consent, template/policy, deduplication and audit semantics.

### Final Definition of Done
Only mark the integration `production ready` when implementation, TEST verification, live acceptance, pilot evidence and release/security approval are all complete. Linear labels/status must reflect these distinct levels rather than collapsing them into a single "Done" claim.

## OW-13 preparation addendum — 2026-11-11

OW-13 may be **prepared in parallel** with OW-12 acceptance, but its actual bounded pilot cannot begin until OW-12 reaches `live acceptance complete`, the scoped allowlist/kill switch has verified controls and an explicitly authorized cohort/time window exists.

See [08_OW13_BOUNDED_PILOT_PREPARATION.md](08_OW13_BOUNDED_PILOT_PREPARATION.md) for proposed waves, admission gates, monitoring, incident stop/rollback procedure and report template.

Linear: [SOF-42 / preparation](https://linear.app/eproo/issue/SOF-42/ow-13-prep-prepare-bounded-openwa-pilot-controls-monitoring-and) In Progress; [SOF-43 / execution](https://linear.app/eproo/issue/SOF-43/ow-13-execute-bounded-openwa-pilot-after-ow-12-live-acceptance-not) Todo, blocked by SOF-41 and SOF-42. **No** live pilot or Production changes authorized.


## OW-14 preparation addendum — 2026-11-12 (planning only; NO-GO)

At the owner's direction the remaining OW-12 and formal OW-13 live tests are **deferred, not waived**. Production readiness can be planned in parallel but not certified or executed. The detailed P0–P5, W01–W10 implementation and governance plan is [10_OW14_PRODUCTION_READINESS_AND_ROLLOUT_PLAN.md](10_OW14_PRODUCTION_READINESS_AND_ROLLOUT_PLAN.md). Its evidence/governance packet is [11_OW14_RELEASE_DECISION_TEMPLATE.md](11_OW14_RELEASE_DECISION_TEMPLATE.md).

The current GitHub implementation CI/migration replay and TEST-only migration state support preparation, **not a formal GO**. Required before any Production activation: SOF-41 `live acceptance complete`, SOF-43 `bounded pilot accepted`, all scoped role/security and provider/webhook/Meta regressions, operations/backup/capacity/monitoring, approved unofficial-provider warning and current NOTE-001 security review with independent release sign-off. No Production environment, migration, secret or gateway changes are authorized by this document.
