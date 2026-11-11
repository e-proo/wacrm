# OW-13 — Bounded OpenWA Pilot Preparation and Operational Runbook

**Status: PREPARATION IN PROGRESS (2026-11-11). LIVE PILOT NOT AUTHORIZED.**

This document prepares the next phase without claiming OW-12 live acceptance, making TEST/Production changes, enabling new outbound traffic or authorizing a pilot.

## Source of truth and governance

- Repository: e-proo/wacrm; branch: refactor/service-platform-v2.
- Pre-preparation HEAD: b6babdfe7931258c976318fc1adb0bc94ae4dc1c.
- [Exact-HEAD CI](https://github.com/e-proo/wacrm/actions/runs/43094036951): success, including lint, typecheck, OW-4/Meta regression, tests and build.
- [SOF-41](https://linear.app/eproo/issue/SOF-41/ow-12-execute-live-openwa-test-acceptance): OW-12 live acceptance In Progress; still blocks pilot activation.
- [SOF-42](https://linear.app/eproo/issue/SOF-42/ow-13-prep-prepare-bounded-openwa-pilot-controls-monitoring-and): OW-13 preparation.
- [SOF-43](https://linear.app/eproo/issue/SOF-43/ow-13-execute-bounded-openwa-pilot-after-ow-12-live-acceptance-not): pilot execution, explicitly blocked by SOF-41 and SOF-42.
- Canonical rollout contract: 05_TEST_PILOT_AND_ROLLOUT.md. PROJECT_NOTES.md NOTE-001 remains open, and Production/GA needs its own OW-14 security decision.

## 1. Strict separation: prepare vs activate

Preparation may overlap remaining OW-12 tests. **Do not activate OpenWA for customer/pilot traffic until every GO gate is independently passed and approved.** No automatic Meta→OpenWA fallback or cutover is permitted. Meta Cloud remains the official/default production provider; OpenWA is optional transport only. CRM, agents, automations, broadcasts, policy and audit stay within WACRM.

### Read-only TEST baseline, November 11, 2026

- One Meta connection is connected; OpenWA has five ready, two failed and one disconnected connection. This is inventory, not pilot admission.
- TEN OpenWA outbound messages remain in sending with no provider message ID; NINE have an outbound idempotency key. Unknown provider outcome is NOT failure and is NOT permission to resend. Exclude them from the pilot cohort.
- Five OpenWA guardrail config rows exist. Zero are manually paused and zero have open circuits at this checkpoint. Six guardrail events were observed over the preceding 24 hours, zero blocked or failed in that limited period. This does not prove kill-switch operability or pilot safety.
- [Offline reconciliation simulation](https://github.com/e-proo/wacrm/commit/b6babdfe7931258c976318fc1adb0bc94ae4dc1c) proves same-key no-blind-resend and unmatched ACK fail-closed in CI; it cannot recover an upstream send outcome. OpenWAClient.reconcileOutbound() deliberately does not invent a provider lookup.

## 2. Verified controls and admission gaps

| Surface | Existing source evidence | Mandatory preflight work |
|---|---|---|
| Provider router | src/lib/whatsapp/transport/router.ts uses account-scoped provider routing; Meta remains default | Prove an out-of-cohort caller cannot opt into OpenWA |
| Guardrails | src/lib/whatsapp/transport/guardrails.ts and migration 149_openwa_guardrails.sql: server-only caps, pacing, manual_paused, circuit state and audit events | Test admin-only immediate pause/resume, in-flight-send caveat, pilot-specific limits, and telemetry/incident alerts |
| Pilot cohort | No server-enforced account + connection + recipient allowlist established in examined outbound send path | **BLOCKER**: implement deny-by-default scoped admission before provider send; no UI-only or agent-chosen gate; audit each decision; fail closed on missing policy |
| Workloads | WACRM routes agents/automations/broadcasts through unified transport | Pilot wave 0 disables these workloads; require workload-specific admission before any expansion |
| Credential and session | Encrypted server-only OpenWA credentials; scoped session and admin QR controls | Rerun current TEST security/tenant checks; avoid raw credentials, QR or personal data in logs |
| Idempotency / reconciliation | Unique outbound key before send; ambiguous outcomes kept unresolved | **BLOCKER**: trustworthy correlation of verified provider native ID to reserved send; no text/time-based guesses or blind resend |
| Webhook | Signed verification, durable receipt and dedup | Prove slow AI/webhook lease and 503 retry behavior cannot create duplicate business effects |
| Meta regression | Current CI tests pass | OW-12 requires live Meta regression with OpenWA present |

## 3. Cohort design (proposal; NOT configured)

- **Wave 0: rehearsal only.** A non-critical isolated TEST tenant, one connected OpenWA session, one or two consenting operator-controlled recipients. No external customers, bulk sending, unattended AI or production data.
- **Wave 1: tightly bounded manual text.** Only one explicitly allowlisted account + connection + 1–2 approved recipients. Suggested conservative ceilings: at most 3 sends/hour and 10 sends/day. These are **proposals**, not current limits and require operator/security approval and verified enforcement.
- **Wave 2: separate permission.** Media, AI, automations or bounded broadcasts only after their OW-12 live gates and a distinct owner-approved expansion decision. Do not auto-expand based on successful text sends.

Every wave requires named accountable operator and backup, approved cohort identities, consent, local time window, quota, observation plan, rollback owner and formal decision. Do not store recipient numbers or secrets in this document. Server admission must use tenant/account + connection + validated provider-native recipient identity, plus explicit workload grants where relevant.

## 4. Pre-activation GO / NO-GO checklist

All items are required and need dated evidence, not assertions:

- [ ] SOF-41 / OW-12 is at **live acceptance complete**, including quoted replies, media, session disconnect/reconnect/restarts, restriction/logged-out scenarios, automation/agents/bounded broadcast, tenant negative tests and Meta live regression.
- [ ] Ambiguous outbound timeout has trustworthy native provider outcome reconciliation or a proven operator workflow leaving unknown results locked without resend; no unexplained duplicates.
- [ ] A deny-by-default, server-enforced pilot allowlist is tested for approved and unapproved tenant/connection/recipient/workload combinations, including service-role boundary and concurrent request behavior.
- [ ] Admin-only pause/kill switch and bounded caps, warmup, spacing, circuit breaker and event audit are proved end-to-end with no unintended sends.
- [ ] Monitoring and paging owner can observe status, webhook retries/errors, send latency, unsettled outcomes, duplicate events and provider restrictions.
- [ ] Exact implementation HEAD CI and clean migration replay pass; TEST RLS/credential/QR safeguards and Meta regression remain green.
- [ ] The pilot uses a non-critical dedicated number, approved recipient consent, healthy session, stable network/tunnel and explicit operator coverage.
- [ ] A written approval records cohort, start/end, quota, exit criteria, monitoring owner and emergency stop authority. No implicit Production permission.
- [ ] PROJECT_NOTES.md risks reviewed. NOTE-001 must be separately resolved/accepted for any eventual OW-14 Production/GA decision.

Unchecked item means **NO-GO**. A green unit suite or previous pilot plan is not a substitute.

## 5. Observability / evidence contract

All queries and alerts must be account + connection + time-window scoped; report counts and redacted identifiers. Never log credentials, QR codes, message text or full recipient JIDs as monitoring dimensions.

| Metric | Source of truth | Expected evidence |
|---|---|---|
| Scoped admission | Future WACRM allowlist decision audit (not yet implemented) | Allowed/blocked by workload; zero out-of-cohort sends |
| Session uptime/reconnect/restriction | whatsapp_connections and verified OpenWA session events | Ready intervals, disconnect count and recovery time |
| Outbound delivery | messages (conversation.account_id, connection_id, provider, status, provider_message_id) | counts sending/sent/delivered/read/failed, ACK delay, native identity coverage |
| Ambiguous/duplicate | messages.outbound_idempotency_key + provider-native proof | unknowns, trustworthy reconciliation, zero confirmed duplicates |
| Signed webhook | whatsapp_webhook_event_receipts | processing delay, dedup, retries/503, processing_error |
| Guardrails | whatsapp_connection_guardrails + whatsapp_guardrail_events | reserved, blocked, failure, paused, circuit_opened and approved cap |
| Agents/automations/broadcast | Existing WACRM business/run/recipient audit, only when separately admitted | workload sends, idempotency and incidents |
| Provider/tunnel resources | OpenWA host and tunnel operator logs | CPU/RAM, reconnects, network buffer/QUIC faults |
| Meta compatibility | Live Meta baseline during same window | no Meta traffic/reply regression |

Proposed cadence: baseline snapshot before enablement, operator observing each first-wave send, end-of-wave review and daily summary for any longer approved window. Define low-sample absolute incident triggers rather than meaningless percentage targets.

## 6. STOP / ROLLBACK and reconciliation runbook

**Immediately stop the affected cohort** for any unauthorized/cross-tenant send; confirmed duplicate physical send; credential/QR leak; restriction/ban/logged_out; Meta regression; inability to prevent a second ambiguous send; or unexpected provider selection. Treat any newly ambiguous send as a pause and human reconciliation event, not a failed send.

Authorized operator sequence (only after control and permissions have been tested):
1. Disable pilot admission and set audited per-connection manual_paused; verify the actual send gate returns a blocked decision. An in-flight provider POST may still complete, so do not assume cancellation.
2. Suspend WACRM automation/broadcast/agent triggers for this pilot cohort as applicable. Do not touch Meta default connections.
3. Capture incident time, scoped account/connection, redacted idempotency key, provider-native ID *if proven*, related receipts and last status. Preserve original records.
4. Reconcile only via signed/provider-authenticated native evidence linked to the exact reserved send and connection. If impossible, keep unknown for manual review; never blind resend or mark sent/failed by inference.
5. Re-run tenant isolation/Meta guard, document rollback latency, obtain explicit owner approval before resuming. Do not automatically unpause on reconnect.

Before Wave 1, rehearse an admission deny, authorized pause, blocked mocked send and explicit resume on a **synthetic zero-WhatsApp-send TEST fixture**. Record signed-off evidence; no direct Production DB updates.

## 7. Pilot report template — leave empty until actual approved execution

~~~text
Written approval / owners: NOT GRANTED
OW-12 live acceptance evidence: PENDING
Approved environment, cohort and consent: PENDING
Current HEAD / CI / clean migrations: PENDING
Connection / session (redacted), Meta baseline: PENDING
Wave / workloads / start-end time / quotas: PENDING
Kill-switch, allowlist and rollback rehearsal: PENDING
Signed webhooks / sends / ACK / delivery counts: PENDING
Duplicate physical sends / ambiguous outcomes / reconciliation: PENDING
Provider restrictions / restarts / resource peaks: PENDING
Guardrails / stops / incidents and resolutions: PENDING
Final review and decision: NOT STARTED / NOT ACCEPTED
~~~

## 8. Responsibilities and Definition of Done

- **SOF-42 (preparation):** Complete the design, map gaps to implementation/CI TEST tasks, review control ownership and document activation gates. May be `preparation complete` only when artifacts and control requirements are reviewed. It does not qualify as `pilot accepted`.
- **SOF-41 (OW-12 in parallel):** Finish outstanding live TEST and true native-outcome reconciliation; no timing-based false closure.
- **SOF-43 (execution):** Blocked until SOF-41 and SOF-42 are done, every GO item passes, and written activation approval is recorded. Only then may a bounded live pilot be run and judged.
- **OW-14:** Later independent rollout/security decision after successful pilot. No production-readiness claim from this file.
