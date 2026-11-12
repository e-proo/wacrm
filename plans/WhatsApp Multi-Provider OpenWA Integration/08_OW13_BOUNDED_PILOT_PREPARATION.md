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


## 14. TEST-only operator-authorized development live trial — 2026-11-12 (NOT formal SOF-43 execution)

**Operator decision:** The project owner explicitly requested initiating real **development-mode TEST pilot sends before OW-12 and the live Agent/Viewer role-negative are complete**, with findings recorded for later remediation and **no Production deployment**. This is a **separate, narrowly controlled development smoke trial**, not approval to close SOF-41/SOF-44, mark SOF-43 `pilot accepted`, or roll out to customers. The previous formal GO/NO-GO gates in §4 and §13 remain binding for the formal bounded pilot and OW-14.

### 14.1 What was actually implemented and changed

- Git branch `refactor/service-platform-v2`; latest CI must be checked for the new code HEAD before trusting runtime changes.
- **TEST-only DB change:** provisionally staged existing `openwa/ready` connection `2dacee52-3486-4b47-96a0-fa4399ac0fb2` in account `8ed95309-96cd-4347-b725-bd8c5039ed4f`. Explicit tenant+provider+ready+not-archived+no-ambiguous-outbound criteria were checked on the write. No new connection or session was created.
- Set its `whatsapp_connection_guardrails` to **manual_paused=true** (fail-closed staging), `hourly_cap=3`, `daily_cap=10`, `first_touch_daily_cap=1`, `minimum_interval_ms=15000`, `jitter_ms=3000`, `warmup_hourly_cap=3`, `warmup_daily_cap=10`, `failure_min_attempts=2` with 15-minute window and 50% failure threshold; seven-day warmup window. Wrote one `paused/ow13_dev_trial_staged_no_send` audit event. Postflight confirmed exact limits, paused state, 0 active admissions, 0 ambiguous sends for this connection, 1 staging audit.
- Other connections and their limits were left unchanged. **10 legacy ambiguous OpenWA sends remain elsewhere** and MUST NOT be resent.
- **Operator utility** `scripts/openwa-dev-pilot.mjs` pins this TEST project/account/connection. It verifies `.env.local` points to the exact TEST host, checks caps, paused state, no unresolved outbound, actual owner/admin approver and explicit recipient consent. It accepts a single canonical recipient interactively (not shell history), writes only a scoped SHA-256 hash for workload `manual`, expires the grant after **4 hours**, and **does not unpause or send WhatsApp**. `status` is read-only and `stop --confirm-stop` pauses the connection, deactivates grants and audits.
- Admin-only WACRM connection-list API and localized settings show **actual runtime** pilot admission enforcement (`enforced` true/false). This is informational and never exposes recipient hashes or credentials.
- **No actual WhatsApp message sent by this change or by the engineering assistant.** The user's local WACRM process/`.env.local` cannot be modified or restarted through the available read-only browser connection, and a consenting destination is not yet known. Therefore **DEV live trial execution is staged, not yet provider-verified**.

### 14.2 Observed hazards and reconciliations required

1. **Duplicate provider identity:** WACRM TEST shows multiple `ready` connections for the same WhatsApp phone identity, while OpenWA's locally observed sessions show only two connected and one disconnected. The selected connection is present as connected in the OpenWA UI, has zero ambiguous outbound and zero sends in the recent 24-hour read; this does NOT prove that duplicated identity/session state is harmless. Resolve/review the duplicate connections before using `--ack-duplicate-sessions`. Do not create a replacement session blindly.
2. **Global opt-in mode:** `OPENWA_PILOT_MODE=enforce` currently checks pilot admission for **all OpenWA outbound on that WACRM server**, not just the selected connection. With no approval rows, sends from other OpenWA sessions will fail closed; it does NOT automatically block inbound nor replace the per-connection Pause control. Do not flip to `off` as an emergency stop: `off` disables this extra admission gate. The explicit Pause plus cohort revoke is the correct rollback.
3. **Recipient consent:** a controlled owner/consenting test destination, canonical `@c.us` or `@lid` identity, and a real approved-by TEST owner/admin identity have not been supplied. Never derive consent from previous messages and never publish the actual recipient in GitHub/Linear.
4. **Deferred security:** real `Agent`/`Viewer` HTTP-403 and wrong-tenant negative tests, reconnect/pause persistence, alert delivery, complete OW-12 live acceptance, uncertain native provider outcomes and Meta live regression remain open. They are recorded as `not tested`, not `pass`.
5. **Environment:** browser observation shows `http://localhost:3000` WACRM and `http://localhost:2886` OpenWA, but browser access here is read-only and cannot update local secrets or send messages. The new settings signal must read **ON** after the operator restarts the local server.
6. **NOTE-001** Supabase security debt remains a Production/GA obstacle, independent of this isolated TEST exercise.

### 14.3 Precise operator procedure — development trial only

On the operator's local WACRM checkout:

```powershell
git checkout refactor/service-platform-v2
git pull origin refactor/service-platform-v2
# Check .env.local uses NEXT_PUBLIC_SUPABASE_URL=https://pqirsnfupofhulmewakq.supabase.co
# Set OPENWA_PILOT_MODE=enforce in .env.local (do NOT commit it).
# Restart npm run dev to load the new value. Verify the new admin Settings alert says enforcement ON.
node --env-file=.env.local scripts/openwa-dev-pilot.mjs status
```

Only after reviewing the duplicate-session warning, verifying the dedicated TEST connection and obtaining the controlled recipient's consent, run from a **local interactive terminal**:

```powershell
node --env-file=.env.local scripts/openwa-dev-pilot.mjs grant --approver=YOUR_TEST_ADMIN_USER_UUID --consent-confirmed --ack-duplicate-sessions
```

The command prompts for **one** approved recipient, does not print/store the plaintext identity and writes a 4-hour `manual` allowlist grant. The `--ack-duplicate-sessions` flag is **not permission to ignore** an unresolved identity/session conflict: first ensure the selected OpenWA session is really connected and that WACRM is routing to that exact connection. The tool deliberately leaves the selected session **paused**.

Then, and only then: in WACRM admin settings verify pilot enforcement **ON**, resume **only the selected connection**, and use WACRM Inbox to send **a single small text** to the approved operator-controlled recipient. Observe `whatsapp_openwa_pilot_admission_events`, `whatsapp_guardrail_events`, the exact `messages` identity and status, and the OpenWA recipient's actual delivery; no automation/AI/broadcast, no unknown-recipient send, no test resend of old ambiguous messages. On unexpected outcome, STOP and preserve evidence.

```powershell
node --env-file=.env.local scripts/openwa-dev-pilot.mjs stop --confirm-stop
node --env-file=.env.local scripts/openwa-dev-pilot.mjs status
```

**Exit/stop evidence required:** at least one `allowed=true` manual admission on the approved connection, exact native provider message identity and non-ambiguous observed outcome, <=3 reserved sends/hour, <=10/day, manual paused and zero active grant after STOP, and no duplicate physical send. Do not report a provider success until both actual recipient/provider evidence and WACRM audit agree.

**Status (this checkpoint):** isolated TEST candidate is **STAGED + PAUSED**, server runtime enforcement **NOT YET OBSERVED ON**, allowlist **EMPTY**, actual WhatsApp trial send **NOT STARTED**. SOF-43 remains blocked; a separate development-trial tracking task should record operator input and proof without lifting the formal rollout gates.


## 15. Unified DEV pilot controls via WACRM UI and terminal — 2026-11-12

This section supersedes the §14 assumption that the first pilot approval and start are available **only via CLI**. A dedicated admin-only UI and CLI now manage the **same tenant-scoped TEST guardrail and allowlist rows**. No new database schema, Production mutation or WhatsApp provider send is needed to install these controls.

### Existing status output: how to read it

`ready` means WACRM connection state, not proof that the upstream gateway currently routes to that session. `paused=true` blocks sending; caps of 3/hour, 10/day and first-touch 1/day are TEST guardrails. `active_admissions=0` means no recipient can pass the enforced pilot admission check. `same_identity_ready_connections=5` is a real duplicate-identity warning and must be reviewed before activation. `local_env_pilot_mode=enforce` means **only** that the CLI's process read `.env.local`. `runtime_mode_confirmed=false` is intentionally non-authoritative because a CLI cannot inspect another running Next.js process environment. The server-backed WACRM admin settings banner and the new protected pilot GET endpoint are the runtime truth.

### Admin-only UI

After syncing the branch and restarting the local Next.js server, open **Settings → WhatsApp → WhatsApp Web (OpenWA)**. For the pinned TEST connection `2dacee52-3486-4b47-96a0-fa4399ac0fb2` only, the new **DEV Pilot** panel exposes:
- Server-verified `enforced` and active/paused state, current active approvals, unresolved outbound count and duplicate-identity count.
- Editable **caps**, allowed only while paused: `hourly_cap 1..3`, `daily_cap 1..10`, `first_touch_daily_cap 0..1`, `minimum_interval_ms 15000..600000`, `jitter_ms 0..600000`. Warmup caps remain at or below chosen hourly/daily caps.
- A consenting test recipient field that is **not stored as plaintext**, explicit consent checkbox and, if duplicate identity exists, an explicit session review acknowledgement; approval is hashed server-side, `workload=manual` only and expires in at most four hours.
- **Start** requires actual server `OPENWA_PILOT_MODE=enforce`, paused ready connection, **exactly one unexpired manual grant**, no other active workload grant, no unsettled sends and safe caps. It unpauses the connection and records an audit event; it **does not dispatch a message**.
- **Stop** pauses the connection and revokes all active pilot grants for that connection, with auditable state. Already in-flight provider sends may still complete.

The generic OpenWA `resume` action is specifically blocked for this pinned TEST connection, to prevent bypass of admission and limit verification; use the DEV Pilot panel or verified CLI for activating it. Generic `pause` remains an extra emergency-stop mechanism but does not automatically revoke grants; prefer Pilot **Stop**.

Only an authenticated WACRM owner/admin of the exact TEST tenant can call `GET/POST /api/whatsapp/connections/openwa/[connectionId]/pilot`. This route hard-pins both the TEST Supabase project and the TEST account/connection; it rejects any other project, account or connection. The browser receives counts/booleans/caps only, not recipient hashes or service credentials. A real Agent/Viewer HTTP-negative acceptance test is still **DEFERRED / NOT WAIVED**.

### Terminal — same database controls

```powershell
git checkout refactor/service-platform-v2
git pull origin refactor/service-platform-v2
# Ensure .env.local points to https://pqirsnfupofhulmewakq.supabase.co.
# Set OPENWA_PILOT_MODE=enforce then restart npm run dev.
node --env-file=.env.local scripts/openwa-dev-pilot.mjs status
node --env-file=.env.local scripts/openwa-dev-pilot.mjs limits --hourly=3 --daily=10 --first-touch=1 --interval-ms=15000 --jitter-ms=3000
# Verify WACRM's server-side banner ON, review duplicate sessions, and obtain recipient consent.
node --env-file=.env.local scripts/openwa-dev-pilot.mjs grant --approver=YOUR_TEST_ADMIN_USER_UUID --consent-confirmed --ack-duplicate-sessions
node --env-file=.env.local scripts/openwa-dev-pilot.mjs activate --confirm-activate --runtime-verified --ack-duplicate-sessions
# If anything is unclear, stop and revoke:
node --env-file=.env.local scripts/openwa-dev-pilot.mjs stop --confirm-stop
node --env-file=.env.local scripts/openwa-dev-pilot.mjs status
```

`grant` prompts for recipient interactively. **Never put recipient identities or any keys in terminal command arguments or logs.** `activate --runtime-verified` is an explicit **operator assertion** after observing the admin UI banner; the CLI still cannot prove the actual Next.js process environment. Use UI activation when possible because it checks enforce mode on the running server.

**Global runtime caveat:** `OPENWA_PILOT_MODE=enforce` remains a **server environment safety gate**, and while enabled it checks admission on *all* OpenWA outbound sends from that WACRM instance. It is not a per-connection toggle and must never be changed to `off` as an emergency stop. The new UI/CLI controls activation on **one dedicated connection** by combining guardrail pause and scoped recipient grants; other OpenWA connections with no approved grants are denied while enforce mode is on. The Meta default/provider path remains unchanged.

### Required verification before actual TEST message

1. Verify current code HEAD CI (Lint, Typecheck, Test, Build, Meta regression); no status is assumed from a prior HEAD. Confirm server settings show **ON** after Next.js restart.
2. Confirm exact gateway session is connected and duplicate identities investigated. Consent and receiving destination must be under operator control.
3. Change caps only with the connection paused. Approve exactly one consenting manual recipient; verify approval count 1 while paused.
4. Activate from UI or CLI, send **one** short text only via the existing WACRM Inbox and verify native ID, actual receipt and WACRM status; do not retry ambiguous outcomes.
5. Stop/revoke, confirm zero active grants and paused guardrail state in both UI and CLI; record corresponding events and the send outcome.

**Outstanding evidence:** dedicated UI route security/unit tests are implementation/CI evidence, not a substitute for actual TEST HTTP role-negative tests; cross-tenant negatives, reconnect persistence, webhook/Meta live regression and OW-12 remain pending. Formal SOF-43 still blocked. Separate DEV trial tracking: [SOF-45](https://linear.app/eproo/issue/SOF-45).


## 16. Dynamic TEST session pilot selection and Cloudflare gateway rotation — 2026-11-12

**Motivation:** OpenWA's tunnel URL often rotates during local development; WACRM previously hard-coded the DEV Pilot panel, API and CLI to connection `2dacee52-3486-4b47-96a0-fa4399ac0fb2`. This prevented accepting newly created sessions. The operator requested reusable TEST Pilot controls on **all OpenWA sessions in their account**, not another fixed UUID.

**Observed read-only TEST evidence:** new WACRM OpenWA connection `02527740-9806-45ae-b9b1-1354c25f1d3f` belongs to test account `8ed95309-96cd-4347-b725-bd8c5039ed4f`, with DB status `ready` and a non-null `session_id`, no unsettled `sending` rows, and **no guardrail configuration**. DB `ready` is not authoritative proof of current upstream reachability: verify from the OpenWA dashboard and WACRM Refresh before sending.

### Implemented behavior (code verification separate from operator acceptance)

- **WACRM admin-only API `/api/whatsapp/connections/openwa/{connectionId}/pilot`** accepts any **valid UUID scoped to the authenticated admin's tenant and OpenWA provider on the pinned TEST Supabase project**. Non-TEST environments and unauthorized tenants fail closed. No cross-tenant broad service-role lookup. No migration and no hard-coded connection ID in this server route.
- **`GET` for an unconfigured session is read-only** and returns `configured=false`, with safe suggested caps. This must not be mistaken for a persisted guardrail. New `prepare` action requires explicit confirmation, an existing `ready/connected` session, no unresolved outbound messages or active admission; writes a **paused** guardrail with `3/hour, 10/day, 1 new recipient/day, 15000ms minimum interval, 3000ms jitter`, warmup/circuit defaults, and an audit entry. It **never** auto-grants a recipient or sends a message.
- **Per-connection UI panel** is displayed on every OpenWA card **in TEST only** with a `Prepare Pilot` action for unconfigured sessions; existing `limits/grant/activate/stop` operate on the selected card. Approval remains an account+connection+recipient+workload-scoped SHA-256 hash expiring after max 4 hours. No approval from one connection is inherited by any other session or by a tunnel change.
- **Generic OpenWA `resume` is blocked on TEST for every connection** to prevent a shortcut around the DEV Pilot approval and cap checks. Admin Pilot Start validates server `enforce`, exactly one unexpired `manual` grant, status `ready/connected`, session identity, zero unknown outcomes, caps, and explicit duplicate-identity review. Stop pauses and revokes approvals even after provider session loss or malformed pilot env.
- **CLI** uses `list` to discover current TEST OpenWA connections in the established TEST account and `--connection=UUID` to target any connection for `status/prepare/limits/grant/activate/stop`. It pins project and established TEST account, not a particular session; it does not take contact phone or API secrets in command-line flags. It is a developer tool using a local TEST service-role key (never expose the key).
- **Rotating Cloudflare tunnel URL:** the admin can use the existing top-level OpenWA URL/API key inputs, and then click **Update this connection's gateway URL** on the existing card. The action is TEST-only, validates HTTPS and allowed hosts, calls read-only `GET /api/sessions/{stored_session_id}` against the new URL with the new key, and updates **only that connection's** tenant-scoped encrypted gateway credentials **if the exact upstream session ID matches**. It **does not POST /sessions**, start/reconnect, replace signed webhook secrets, transfer messages, or create duplicate WhatsApp sessions. If no matching session is found, the update is rejected and existing credentials remain intact. Reconfigure signed inbound webhook URL separately if the WACRM public origin also changed.
- **No automatic switching of old session identities**: WACRM `connection_id` and upstream OpenWA `session_id` are stable identities, while the tunnel URL is just a transport endpoint. Reusing the same OpenWA instance after a tunnel change should use the URL-update operation, **not another New Session**.
- No changes to Production, Meta adapter, existing migrations, OpenWA local checkout or actual provider sessions. No auto-resend for ambiguous sends.

### Operator procedure, one selected session (PowerShell)

```powershell
git checkout refactor/service-platform-v2
git pull origin refactor/service-platform-v2
# Ensure .env.local points to https://pqirsnfupofhulmewakq.supabase.co
# Set OPENWA_PILOT_MODE=enforce and restart local npm run dev once.
node --env-file=.env.local scripts/openwa-dev-pilot.mjs list
$connection = "02527740-9806-45ae-b9b1-1354c25f1d3f"
node --env-file=.env.local scripts/openwa-dev-pilot.mjs status --connection=$connection
node --env-file=.env.local scripts/openwa-dev-pilot.mjs prepare --connection=$connection --confirm-prepare
node --env-file=.env.local scripts/openwa-dev-pilot.mjs limits --connection=$connection --hourly=3 --daily=10 --first-touch=1 --interval-ms=15000 --jitter-ms=3000
# Confirm the new upstream session is really connected; investigate any
# duplicate-phone mapping; obtain consent and verify WACRM displays Enforced ON.
node --env-file=.env.local scripts/openwa-dev-pilot.mjs grant --connection=$connection --approver=YOUR_TEST_ADMIN_USER_UUID --consent-confirmed --ack-duplicate-sessions
node --env-file=.env.local scripts/openwa-dev-pilot.mjs activate --connection=$connection --confirm-activate --runtime-verified --ack-duplicate-sessions
# Exactly one consensual manual test message from the WACRM Inbox ONLY.
node --env-file=.env.local scripts/openwa-dev-pilot.mjs stop --connection=$connection --confirm-stop
node --env-file=.env.local scripts/openwa-dev-pilot.mjs status --connection=$connection
```

The `grant` command prompts for one consenting recipient in the terminal; **never paste that phone/JID into source control or Linear**. The `--ack-duplicate-sessions` flag is not evidence of actual gateway identity verification. The CLI `--runtime-verified` argument remains an explicit human confirmation of the server UI; the CLI cannot read another process's environment.

### Testing and gates

- [ ] CI checks **on the exact final HEAD** (Lint, Typecheck, Vitest, Meta regression, Build) all completed/success.
- [ ] Admin UI shows `configured=false` for a fresh connection, then `prepare` produces an actual paused guardrail without any grant.
- [ ] Wrong account, absent provider connection, invalid UUID, Production URL and unauthenticated role cannot change pilot controls.
- [ ] URL rotation with wrong session ID does not change encrypted credentials; exact upstream session ID updates URL/key only.
- [ ] No older connection loses its grant, state or guardrail setting when preparing a different connection; no unapproved recipient can send while `enforce` is ON.
- [ ] Actual gateway status, one manually approved send/ACK, duplicate checks, STOP/revoke/persistence verified on TEST.

**This change lifts the *hard-coded pilot connection* blocker only; it does NOT close** [SOF-46](https://linear.app/eproo/issue/SOF-46) upstream `Socket` startup investigation, [SOF-44](https://linear.app/eproo/issue/SOF-44) live Agent/Viewer negative tests, [SOF-41](https://linear.app/eproo/issue/SOF-41) OW-12 live acceptance or formal [SOF-43](https://linear.app/eproo/issue/SOF-43) GO/NO-GO.
