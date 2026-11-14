# SOF-63 — Deterministic Coverage V2 outbound handoff regression

## Observed TEST failure (2026-11-14)

With one validated TEST-only Task `86e1cbc3-4d2b-4f1f-8f81-45fd64889c1d` and exactly one selected target, the operator's `send` stage invoked the model loop, which returned `handoff` without tools or text. `processAgentTaskOutboundRunQueue` interpreted that as `needs_human` and called `fail_agent_task_outbound_run`, exhausting the target's one attempt. Test result: `scanned=1,attempted=1,reserved=0,sent=0,reconciliation=0,failed=1`.

Hosted TEST evidence: `ai_agent_runs.status=failed`, `error_code=AGENT_OUTBOUND_NEEDS_HUMAN`, target `status=exhausted`, `attempt_count=1`, zero outbound reservations. This is **not an OpenWA transport failure** and no WhatsApp send from the Task occurred. **Do not repeat `send` or reset the exhausted attempt.**

## Root cause and bounded fix

`coverage.sourcing_message@2` is intentionally server-owned deterministic text/template selected by a frozen session provider, and ignores `modelCandidateText`. Yet the outbound worker ran the generative model loop and required that loop not handoff *before* asking the domain policy for a deterministic candidate. The model could handoff on unrelated chat history even though it had no authority to formulate the first outreach message.

- Add an explicit `generation: 'deterministic'` opt-in to the message policy contract, used **only** for Coverage V2; absent/default preserves legacy model-first and handoff.
- The worker retains the AI revision/provider boundary, Task/Target frozen association, and circuit/runtime gates. For an opted-in deterministic policy it additionally calls `authorizeStoredAgentTask` to revalidate frozen Task, revision capabilities and tool policies, status and account scope, then calls `prepareAndReserveCurrentTaskOutboundMessage` with `modelCandidateText=null`. The SQL transaction still verifies eligible target, subscription, time window, exact provider connection, and quotas; delivery remains through the same WhatsApp transport and ambiguity reconciliation.
- Never treat `needs_human` as a success for model-required Task types, and do not use deterministic policy as a general override for arbitrary LLM handoffs.
- Unit regression: deterministic route skips model and still enforces capability checks; legacy V1 handoff fails; runtime gate denies. No schema changes.

## Failed Task recovery and acceptance

Because the original Task target was exhausted without any reservation, it **cannot** be safely retried or requeued: `max_attempts_per_target=1` was an intentionally frozen safety cap. The existing Task completion policy can finalize the exhausted Task after checking zero reservations; a new isolated TEST Task with a unique idempotency identity/revision or a new TEST-only Request can then be created *after* fresh recipient consent/inbound and a renewed `agent` allowlist grant. Do not create a duplicate Task until the previous one is terminal, and don't silently expand caps.

Re-run existing automated CI and TEST-only dry run. One-target **live acceptance still pending**: new Task, scoped prepare, scoped send, receipt, reply and rollback. Production readiness remains out of scope.

## Scoped failure finalization — no send, no retry

The existing `evaluateCurrentTaskCompletion` policy finalizes a `running` Coverage Task with only `exhausted` targets as `partially_completed / supplier_targets_exhausted`. This is a terminal state, not delivery success. An opt-in `finalize_failed` stage was added to the SOF-63 live test command to call **only** this domain completion policy after verifying that the exact TEST Task has one exhausted target, one failed outbound Run, both with `AGENT_OUTBOUND_NEEDS_HUMAN`, and zero reservations.

```powershell
$env:WACRM_AGENT_TASK_CUTOVER_ACCOUNT_ID="8ed95309-96cd-4347-b725-bd8c5039ed4f"
$env:WACRM_AGENT_TASK_ONE_TARGET_TASK_ID="86e1cbc3-4d2b-4f1f-8f81-45fd64889c1d"
$env:WACRM_AGENT_TASK_ONE_TARGET_LIVE="1"
$env:WACRM_AGENT_TASK_ONE_TARGET_STAGE="finalize_failed"
$env:WACRM_AGENT_TASK_ONE_TARGET_CONFIRM="FINALIZE_FAILED_NO_SEND"
npm run test:agent-task-one-target-live
```

This stage never calls the worker, creates a Target/Run/reservation, sends WhatsApp, or resets attempts. It must be invoked **only after green CI** and with operator confirmation. Do not run `prepare` or `send` against the failed Task. After finalization, create a *new TEST-only request/Task identity* (because the existing manual Coverage idempotency key includes request + agent + frozen revision), and verify renewed consent/inbound and OpenWA recipient grant before a second live acceptance attempt. No automatic resend.

## Second isolated TEST attempt fixture

The first Task was closed on hosted TEST at 2026-11-14 14:33 UTC (`partially_completed`, zero reservations). Additive second Coverage Request `82e81d51-7a14-4d83-91cc-b8b40534f7d0` uses the same `SOF63-TEST-20261114` isolated service and one previously confirmed supplier; previous Request remains unchanged. New service-owned request is `active`, 100 SAR, no active business-event rows. No Agent Task or WhatsApp message was created by the fixture operation.

The TEST acceptance worker is now restricted to the new Request, the exact TEST account, the explicit approved CRM contact and OpenWA session. The `finalize_failed` stage remains pinned to the previous Request for historical cleanup only. Green CI, a new UI-created Task, and fresh preflight must precede any new live send; the operator's explicit action is still required.

## Contact cooldown guard and third attempt

Operator ran the second scoped `prepare` at 2026-11-14 15:00 UTC; `materializedTargets=0`. The authoritative SQL materialization RPC refused the selected TEST contact through `contact_cooldown` (one prior Task Target at 14:11:31 UTC with a 60-minute cooldown), but the orchestrator treated `accepted=0` as `no_supplier_candidates` and finalized Task `37be3db6` as `partially_completed` with **zero Targets, zero Runs, zero Reservations**. This is a misleading permanent completion caused by a *temporary, policy-enforced admission denial*; it is not a supplier-history mismatch. Cooldown ends 2026-11-14 15:11:31 UTC.

Fix: classify all-temporary materialization decisions and release Task claim to a future due time (SQL re-evaluates cooldown and quotas on the next tick), with sanitized reason logging; do not bypass or shorten cooldown. Add TEST-only preflight using the frozen `cooldownMinutes` and prior target timestamps, stopping before claim while still blocked. Preserve rejection of permanently suppressed candidates and zero supplier candidates. Both corrections have targeted regressions / gate verification.

A new third sandbox Request `4bec8b51-3542-4fb1-933c-699408d69e62` was created under the same isolated `SOF63-TEST-20261114` service with one previously verified historical supplier, no active business event/outbound. The scoped operator command now takes `WACRM_AGENT_TASK_ONE_TARGET_REQUEST_ID` as a required separate TEST-only fixture selector instead of needing source edits each attempt. Task ID remains a second mandatory runtime input, and all account/service/contact/session/grant and exclusivity checks remain frozen. Operators must create a new Task in the UI and carry out `prepare` before any independently authorized send. No Production modifications.

## Fourth acceptance blocker — OpenWA guardrail rolling daily cap (2026-11-14)

Operator invoked `send` exactly once for third TEST Task `8ff3a4e0-53c0-4c28-a433-ee8338cc8c00` and scoped request `4bec8b51-3542-4fb1-933c-699408d69e62`. Result `scanned=1,attempted=1,reserved=1,sent=0,reconciliation=1,failed=0`. Stack reported typed `OpenWAPreDispatchDenied` with `providerDispatchAttempted:false`, `OpenWA send blocked by WACRM guardrail: daily_cap`. The inner provider adapter was **not invoked** in this attempt. TEST had one outbound reservation `270e792e-f73b-4f55-b2dd-07ce247d89ac` mistakenly `requires_reconciliation`; no local/remote message IDs, Run `failed`, target still `in_progress` but with `OUTBOUND_REQUIRES_RECONCILIATION`, Task `running`. NEVER blindly retry this record.

Root cause: frozen Pilot `daily_cap=1` counts all connection-level `decision='reserved'` ledger entries across **all workloads**, not only the current Agent Task. TEST already had 14 reservations within the preceding rolling 24h (manual + agent, some success) from prior testing. Connection-only guardrail status `ready` and a valid allowlist grant do **not** imply remaining quota. The latest reservation was 2026-11-14 12:48:07 UTC, so with cap=1 the rolling day will not have an empty slot before approximately **2026-11-15 12:48 UTC / 15:48 Yemen**, unless the configuration or ledger changes. Do not raise Pilot caps or delete historical ledger reservations to force acceptance. Current grant expires 2026-11-14 16:51:23 UTC and must be renewed after fresh same-session, own-number inbound before another real send.

### Bounded implementation

- Additive migration `162_agent_task_openwa_pre_dispatch_denial.sql` defines service-role-only `finalize_agent_task_outbound_pre_dispatch_denial(account, reservation, worker, reason)`. It can only handle a currently claimed `sending` OpenWA reservation with exact worker, account, non-null frozen connection, no local/remote message IDs, claimed outbound Run and in-progress Target. The same transaction marks outbound identity `failed`, Run `failed`, Target `exhausted` and logs `message.pre_dispatch_denied` with provider_dispatch_attempted=false / retry_allowed=false. No provider call or new reservation. A transport timeout cannot enter this path because the application only invokes it for concrete `OpenWAPreDispatchDenied` instances, and any database-claim failure goes to conservative reconciliation.
- `outbound-delivery.ts` catches the typed error **before** the ambiguous-outcome fallback. `outbound-worker.ts` doesn't redundantly fail an already terminal Run.
- SOF-63 operator test preflights OpenWA reserved-ledger hourly+daily windows (including manual/agent) before claiming a Run. The SQL guardrail remains the authoritative race-safe admission check. Pure regression tests verify rolling day/hour calculations, older expired reservations, and malformed caps.
- CI runs the migration replay and new `agent-task-openwa-pre-dispatch-smoke.sql` to assert service-only grants and fail-closed claim/transport requirements; existing Meta/transport tests remain in scope.
- **Historical TEST reservation** is not automatically mutated by the new RPC: it is already `requires_reconciliation`, outside the new live `sending` claim path. Reconcile the exact record only after explicitly verifying the original typed pre-dispatch denial and the matching guardrail audit event, without any resend or changing quotas. Keep SOF-63 In Progress until this and a fresh send/reply/rollback acceptance are proven.

## Fast DEV acceptance on same OpenWA session with Pilot disabled (2026-11-14)

The operator explicitly disabled **per-connection OpenWA Pilot** on the current TEST session and asked for higher experimentation limits. It is important not to conflate **OpenWA transport Pilot** with **Agent Task Cutover**:
- OpenWA TEST connection `02527740-9806-45ae-b9b1-1354c25f1d3f`: `pilot_enabled=false`; this bypasses *only* the OpenWA pilot allowlist admission check. The transport **continues enforcing** `reserve_openwa_guardrail_send`, the shared rolling 1h/24h caps, emergency manual pause, circuit breaker, tenant/session binding and signed webhooks. Actual gateway connectivity is not proven by DB `ready` alone. The operator has separately configured current connection caps `hourly_cap=60`, `daily_cap=500`, `warmup_until=NULL`, `first_touch_daily_cap=100`. No change was made to these operator-set caps. At verification there were 14 legacy reservations in the 24h ledger but no reservations in the most recent hour; the 500/day cap therefore does not block a single new delivery.
- **Agent Task Cutover** remains `pilot`, outbounds enabled, no triggers enabled, no nonterminal Tasks and no unsettled sends. The operator-requested **TEST-only Agent Task limits** were increased under the *existing bounded cutover readiness maximums*: WhatsApp channel `daily_run_limit=10`, `daily_target_limit=10`, `daily_message_limit=20`, account `daily_message_budget=30`. These are account/channel ceilings; **SOF-63 acceptance still forces one owned CRM test contact, one Target, one attempt, zero followups, exactly one approved Run**.
- The disabled OpenWA Pilot revoked the previously active hashed `workload=agent` recipient allowlist entry (there is one historical, now-inactive entry). To retain SOF-63's independently bounded *owned-number* acceptance even with Pilot disabled, `one-target-worker.live.test.ts` still freezes the exact TEST project/account/service/contact/session, active TEST-only Request, one Task and one Run; it now requires `WACRM_AGENT_TASK_ONE_TARGET_PILOT_OFF_ACK=TEST_OWN_NUMBER_SCOPED` when the DB says `pilot_enabled=false`. It verifies the historical **signed recipient hash** still matches a recent inbound message from the same chosen account/contact/OpenWA connection. This historical hash is solely a **test-recipient identity constraint**, not a resurrection of the revoked admission grant. If Pilot is turned back on, a fresh active/unexpired `agent` grant is required again. Missing grant history, no incoming test message, wrong contact/session, unexpected bound or paused/circuited connection causes failure. This is a TEST-only operator experiment, **not** a default production or multi-recipient bypass.
- The previous third Task `8ff3a4e0-53c0-4c28-a433-ee8338cc8c00` is terminal `partially_completed`, `OPENWA_PRE_DISPATCH_DENIED`, zero sent, zero unsettled; never retry.
- Fourth distinct, isolated TEST Coverage Request `246103aa-6f20-4417-9e9f-8b996fa2c770` has been created for the same `SOF63-TEST-20261114` service, 100 SAR, one existing historical owned-number supplier, zero active business-event delivery, zero Tasks at creation. No WhatsApp send was performed.
- Existing **60-minute** SQL contact cooldown for the last attempt remains enforced by Target materialization and scoped `prepare` preflight. The most recent Target last-attempt is `2026-11-14 15:26:42 UTC` and earliest corresponding next eligibility is **2026-11-14 16:26:42 UTC (19:26:42 Yemen)**; this is not bypassed for speed.

**Operator sequence (after exact-HEAD CI success)**: verify OpenWA actual session connected; create exactly one UI Task for Request `246103aa-...`, `Phase 18 Coverage Pilot`, existing selected owned TEST CRM contact, same OpenWA connection, `maxTargets=1` / `maxAttemptsPerTarget=1`. Require `POST /api/agent-tasks 201` and the new Task ID (never reuse one of the three terminal Tasks). On latest HEAD, run only the isolated `prepare` command with:
```powershell
$env:WACRM_AGENT_TASK_CUTOVER_ACCOUNT_ID = "8ed95309-96cd-4347-b725-bd8c5039ed4f"
$env:WACRM_AGENT_TASK_ONE_TARGET_REQUEST_ID = "246103aa-6f20-4417-9e9f-8b996fa2c770"
$env:WACRM_AGENT_TASK_ONE_TARGET_TASK_ID = "<NEW_TASK_UUID>"
$env:WACRM_AGENT_TASK_ONE_TARGET_LIVE = "1"
$env:WACRM_AGENT_TASK_ONE_TARGET_PILOT_OFF_ACK = "TEST_OWN_NUMBER_SCOPED"
$env:WACRM_AGENT_TASK_ONE_TARGET_STAGE = "prepare"
$env:WACRM_AGENT_TASK_ONE_TARGET_CONFIRM = "PREPARE_ONE_TARGET_NO_SEND"
npm run test:agent-task-one-target-live
```
Do not invoke `prepare` before contact cooldown completes; no sending in this stage. Independently inspect exact 1 Target + 1 queued Run + 0 outbound reservations before separately confirmed **one** `send`. The `send` stage uses `SEND_ONE_TARGET_TEST_NOW` and retains all quota/transport guards. A successful accepted send must be verified by receipt on operator's own device and inbound reply correlation; unknown result is never retried blindly. Finally roll back Agent Task Cutover and restore conservative OpenWA Pilot on the TEST connection after acceptance. Keep SOF-63 In Progress until these gates.
