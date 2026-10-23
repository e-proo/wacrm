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
