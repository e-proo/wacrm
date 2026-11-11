# OW-13 — Bounded OpenWA Pilot Preparation and Operational Runbook

**Status: PREPARATION IN PROGRESS (2026-11-12). TEST schema/security/synthetic SQL verified; LIVE PILOT NOT AUTHORIZED.**

This document prepares the next phase without claiming OW-12 live acceptance, enabling new outbound traffic or authorizing a pilot. Additive migration 155 was applied to **TEST only** on 2026-11-11 UTC; **Production remains unchanged**.

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

## 2. Baseline controls and admission gaps (historical pre-155 inventory; see §11 for current TEST evidence)

| Surface | Existing source evidence | Mandatory preflight work |
|---|---|---|
| Provider router | src/lib/whatsapp/transport/router.ts uses account-scoped provider routing; Meta remains default | Prove an out-of-cohort caller cannot opt into OpenWA |
| Guardrails | src/lib/whatsapp/transport/guardrails.ts and migration 149_openwa_guardrails.sql: server-only caps, pacing, manual_paused, circuit state and audit events | Test admin-only immediate pause/resume, in-flight-send caveat, pilot-specific limits, and telemetry/incident alerts |
| Pilot cohort | Historical baseline before migration 155: no server-enforced allowlist in the examined send boundary | **Implemented + CI + TEST SQL verified in §11**; pilot activation and operator-led end-to-end acceptance are still blocked |
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
| Scoped admission | whatsapp_openwa_pilot_allowlist + whatsapp_openwa_pilot_admission_events (migration 155; TEST only) | Allowed/blocked by workload; zero out-of-cohort sends |
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

## 10. SOF-44 implementation checkpoint — 2026-11-11 (historical baseline; superseded by §11)

Source implementation commits after the initial runbook: [a24032b3](https://github.com/e-proo/wacrm/commit/a24032b3d1554bdaf2d2c1f3cb309b11b1dce7b1), [90ecbe62](https://github.com/e-proo/wacrm/commit/90ecbe6203c72ca54fb7da5a8f97f2ac8e5432bd), [73cdfc49](https://github.com/e-proo/wacrm/commit/73cdfc49902e0cc3dd1220eddc8714dba016174e), [3a9d5590](https://github.com/e-proo/wacrm/commit/3a9d5590061701350dc95a91b45d7ec1c1a6eb10), [938955ac](https://github.com/e-proo/wacrm/commit/938955aca5dc8b0cf1fc646f069e618bb0db7c89), [559ad4f2](https://github.com/e-proo/wacrm/commit/559ad4f2295613bd2275bdd83cf971b7d4694027).

- **Implemented, verification pending:** migration `155_openwa_pilot_admission.sql` adds inactive-by-default server-only hashed recipient/workload allowlist and tenant-scoped decision audit; `supabase/ci/openwa-pilot-admission-smoke.sql` is wired into the Migrations workflow. No policies/recipients are seeded and the runtime opt-in `OPENWA_PILOT_MODE` remains OFF.
- **Implemented, verification pending:** OpenWA-only send boundary enforces allowlist via service-role RPC when explicitly set to `enforce`; unknown values/error/missing entries DENY; it checks admin pause and revalidates a paced send before provider dispatch. No changes to Meta adapter or business caller APIs.
- **Implemented, verification pending:** settings list returns only account-scoped paused state to authorized admins; translated admin `Pause sending`/`Resume sending` actions call existing protected API; new tests cover scoped visibility, unauthorized/admin actions, audit failure, allowlist denial, LID identity, mid-wait revocation and Meta routing.
- **Original checkpoint (now superseded):** at the time of this implementation note, CI/Migrations replay and TEST migration application were pending. See §11 for completed evidence. No live provider send, admission activation or Production change authorized.
- **Still NO-GO:** operator approval workflow for adding allowlist rows, HTTP/UI operator-led pause/resume rehearsal, tested alerting, true provider reconciliation and full OW-12 live acceptance. No live pilot allowed.


## 11. Migration 155 TEST-only acceptance — 2026-11-11 UTC / 2026-11-12 Asia/Aden

- **Source runtime HEAD**: `b0977087f7618b30c9b96e848064c73e5f47f03d` on `refactor/service-platform-v2`. Exact-runtime-head [CI #43101200591](https://github.com/e-proo/wacrm/actions/runs/43101200591) and [Migrations #43101200577](https://github.com/e-proo/wacrm/actions/runs/43101200577) are `completed/success`. A documentation-only follow-up commit needs its own workflow verification; do not reuse runtime CI as evidence for any new runtime changes.
- **Target**: Supabase `wacrm test` (`pqirsnfupofhulmewakq`, ACTIVE_HEALTHY); **not Production**. Applied the exact SQL from `supabase/migrations/155_openwa_pilot_admission.sql` (Git blob `8dc6472b3481cbf8d613817097fb95a83b2a10da`) via Supabase migration API. Supabase recorded migration version `20261111212013`, name `openwa_pilot_admission`; the repository's `155_` prefix is a source file ordinal, not that remote version.
- **Schema security checks (TEST)**: RLS enabled on `whatsapp_openwa_pilot_allowlist` and `whatsapp_openwa_pilot_admission_events`; neither `anon` nor `authenticated` has SELECT/INSERT on either table; `service_role` has SELECT. RPC `check_openwa_pilot_admission(uuid,uuid,text,text)` is `SECURITY INVOKER`, executable by `service_role` but not `anon`/`authenticated`.
- **Transactional test**: Executed the exact `supabase/ci/openwa-pilot-admission-smoke.sql` (blob `5335547b069be5657b2c72f76d4a2a0778eb1bbd`) on TEST with `BEGIN ... ROLLBACK`, PASS: inactive/missing admission denies by default; approved account/connection/recipient/workload permits; wrong tenant, workload, recipient, malformed hash and expired permission deny; successful admission audit checks.
- **Separate synthetic stop drill**: On a rollback-only synthetic `auth.users` identity, tenant and ready OpenWA connection, `reserve_openwa_guardrail_send` returned allowed before pause, `manual_pause` denial while `manual_paused=true`, and allowed after resume; verified `paused`/`resumed` and blocked audit records. This exercised DB functions and persisted no send reservation; **it did not call the Next.js admin HTTP route or the OpenWA provider and does not prove an in-flight provider POST can be canceled**.
- **No activation/persistent fixtures**: Post-test SELECT confirmed zero rows in pilot allowlist and admission events, zero active cohort entries, and no remaining synthetic users, connections, guardrails or events. Retain `OPENWA_PILOT_MODE=off`; this is an operator runtime setting, **not independently readable from Supabase**. No historic ambiguous send was retried.
- **Security debt**: Supabase TEST Security Advisor continues to report prior `NOTE-001` findings. `rls_enabled_no_policy` now lists 5 tables (previously 3), including the two intentionally inaccessible service-only pilot tables. Other existing warning families remain (mutable function search path 16; extension in public 1; anon SECURITY DEFINER executables 22; authenticated SECURITY DEFINER executables 28; leaked-password protection 1). This checkpoint does not establish production readiness.
- **Outstanding SOF-44/OW-13 gates**: HTTP/UI operator-led pause/resume and authorization negative tests against TEST deployment; alert ownership and rollback runbook rehearsal; full OW-12/SOF-41 live acceptance (media, reconnect/restart, real Meta regression, duplicate/ambiguous/reconciliation, tenant negatives); SOF-42 preparation and explicit approved pilot cohort/time window. SOF-43 live pilot remains **BLOCKED / NO-GO**. No Production/GA claim.


## 12. Operator-deferred authorization negative test — 2026-11-12 (OPEN, NOT WAIVED)

**Decision:** The operator explicitly chose to defer the TEST live `Agent`/`Viewer` role-negative exercise so that **non-live preparation** of OW-13 can proceed. Deferral is **not acceptance**, a security sign-off, or permission to close SOF-44 or unblock SOF-43. Revisit before any live pilot activation.

**Evidence so far:**
- Operator reported 6/7 emergency-stop steps PASS: admin pause, reload persistence, HTTP response, new-send denial, resume, and audit log. Agent/Viewer negative remained **not tested**.
- Independent TEST read-only `whatsapp_guardrail_events` corroborated a single-connection sequence on 2026-11-11 UTC: `paused/admin_emergency_control` at 21:31:49, `blocked/manual_pause` at 21:32:52, `resumed/admin_emergency_control` at 21:33:14.
- Current `requireOpenWASessionAdmin` and server route enforce `canEditSettings` (owner/admin), with denied auth mapped to HTTP 403, plus CI test coverage. This does not substitute for a real lower-role HTTP check.
- [CI at documented baseline HEAD `6939977`](https://github.com/e-proo/wacrm/actions/runs/43102712313) completed/success. Migration 155 remained TEST-verified as recorded in §11.

**Deferred acceptance procedure (do not schedule as an automatic send):**
1. Use a dedicated TEST `Agent` session, then a `Viewer` session, on the **same account** as the tested connection. Do not use production users.
2. Record a safe baseline of the target connection's `manual_paused`, `updated_at` and latest `whatsapp_guardrail_events`. Keep the connection **paused** while attempting an unauthorized `{"action":"pause"}` so that an authorization bug cannot unintentionally unpause it.
3. Invoke `POST /api/whatsapp/connections/openwa/{connectionId}` with `{"action":"pause"}` using each role's own authenticated browser session; expect HTTP **403** and no state/audit mutation.
4. Separately, test a wrong-tenant connection ID and confirm it cannot be mutated. Confirm the target state's persistence with a genuine authorized admin session.
5. Capture redacted Network evidence (role, HTTP status and short request/response without cookies/tokens), relevant DB before/after counts and time. Mark accepted only when both roles and tenant scope are proven. Do **not** repeat or resend existing ambiguous WhatsApp messages.

**Tracking:** [SOF-44](https://linear.app/eproo/issue/SOF-44/ow-13-prep-enforce-deny-by-default-pilot-allowlist-and-verify-admin) remains In Progress and blocks SOF-43. No lower-role authorization test is claimed as passed.

## 13. OW-13 Pilot Wave 0 preparation package — NO ACTIVATION (2026-11-12)

### Verified non-live TEST baseline

- TEST project `pqirsnfupofhulmewakq` is healthy; **8 non-archived OpenWA connections** of which **5 are `ready`/`connected`**. These are available candidates to evaluate, **not an approved cohort**.
- **5** guardrail configuration rows; none currently `manual_paused`, no open circuits. Existing configured `hourly_cap=60` and `daily_cap=500` on all five rows. **These are NOT approved pilot caps**: the tentative Wave 1 **3/hour and 10/day** ceilings from §3 must be deliberately set/verified for the approved connection before sending, together with warmup and first-touch caps, pacing and failure circuit thresholds.
- **0** pilot allowlist rows, **0** active rows, **0** pilot admission audit events. Preserve zero entries in Wave 0.
- **10** `messages` rows for OpenWA remain `sending` without `provider_message_id`; quarantine from any cohort. Do not resend, reclassify by timing, or assume delivery.
- `OPENWA_PILOT_MODE` is a server runtime setting, **not observable through the DB**. In code, `off` / unset means the *pilot allowlist is not enforced*; it does **not** globally disable OpenWA transport. Therefore **no live pilot GO** without operator-verified `enforce` on the intended TEST deployment, approved allowlist, role security, and denial evidence. Do **not** change this setting during Wave 0.

### Preparation tasks permitted now (zero new WhatsApp sends)

1. **Select on paper only** one isolated, non-critical TEST account and one dedicated, healthy OpenWA session; identify the accountable owner and backup. Do not select a Production account or add recipients.
2. **Consent and control**: obtain written approval from any proposed test recipients and the pilot owner; privately record 1–2 controlled identities, with no phone numbers/JIDs/tokens committed to GitHub or Linear. WACRM stores only scoped hashes as specified in migration 155.
3. **Runtime preflight**: check service URL, signed webhook route/retry posture, session restart/disconnect/runbook, dedicated tunnel/network operator, and that the app targets TEST. This is observation only—no session mutation is required for preparation.
4. **Safety preflight**: plan explicit per-connection `hourly_cap<=3` and `daily_cap<=10` for a future separately authorized Wave 1; review `first_touch_daily_cap`, `minimum_interval_ms`, `jitter_ms`, `warmup_until` and circuit conditions. Do not change current guardrail rows merely for planning. Prepare a scoped admission `manual`-only proposal; `agent`, `automation`, `api`, `broadcast` remain excluded until individually approved.
5. **Telemetry preflight**: prepare account+connection+window scoped monitoring from `whatsapp_openwa_pilot_admission_events`, `whatsapp_connection_guardrails`, `whatsapp_guardrail_events`, `messages` and signed webhook receipts; track counts/status/restriction/latency/unknown outcome without plaintext recipients, payloads or credentials. Designate incident observer and on-call backup; no alerting is claimed tested yet.
6. **Operator STOP rehearsal plan**: record last-verified admin pause/blocked/resume evidence (§12), plan an independent lower-role negative test before activation, reconnect-persistence test, and runbook for already-in-flight provider posts (cannot be retroactively canceled).
7. **Approval packet**: keep `cohort`, `consent`, `start/end`, `owner`, `backup`, `session`, `caps`, `alert thresholds`, `stop authority`, `reconciliation method`, `Meta live regression` and `OW-12 acceptance links` as **PENDING** until verified. Obtain separate explicit written GO for a small Wave 1, not from this document.

### Pre-activation hard gates (all mandatory)

- [ ] SOF-41 **OW-12 live acceptance complete** with real TEST evidence, including Meta live regression and ambiguous-outcome handling.
- [ ] SOF-44 **Agent/Viewer and wrong-tenant HTTP denial verified** (deferred, NOT waived), plus pause persistence across reconnect and in-flight semantics understood.
- [ ] Exact pilot code HEAD, CI, clean migration replay, TEST grants/RLS and approved-operator API all verified on the same deployment.
- [ ] **Actual** Wave 1 connection caps/pacing/circuit configured and checked against approved 3/hour and 10/day (or stricter) for the authorized connection; current 60/500 is not acceptable.
- [ ] Operator confirms `OPENWA_PILOT_MODE=enforce` **before any pilot dispatch**, with negative missing-cohort/recipient/workload evidence; admission never inferred from the pilot flag alone. Other OpenWA traffic remains separately governed.
- [ ] Monitoring/incident ownership and rollback tested, dedicated noncritical session and consent approved, signed webhooks healthy, no unsafe resend path.
- [ ] SOF-42 preparation evidence reviewed and marked at its actual completion level; formal pilot **GO** recorded in SOF-43 identifying cohort, constraints and time window.

Until all gates pass, **NO-GO**: no active allowlist, no `enforce` flip for a pilot, no external or bulk send, no claim of production readiness.
