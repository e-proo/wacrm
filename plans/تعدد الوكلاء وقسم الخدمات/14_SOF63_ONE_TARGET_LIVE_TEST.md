# SOF-63 — One-target OpenWA TEST acceptance (operator-gated)

**Status:** NOT authorized for live send until all preflight gates pass. This document is an execution checklist, not proof of live acceptance.

## Safe preflight

1. On exact `refactor/service-platform-v2` HEAD verify CI + Migrations completed/success and TEST migration 159/160 available. Do not run on Production.
2. Inspect TEST `inspect_ai_agent_task_test_cutover_readiness(account_id)`. Require `ready=true`, `mode=disabled`, no ambiguous messages/active runs or open circuits before enrollment.
3. Choose precisely **one account-scoped, not archived, status=ready OpenWA connection**. Confirm its gateway session is genuinely connected; DB `ready` is not sufficient by itself. No Meta fallback.
4. Record **explicit consent** from the owner of a TEST-only number, and verify this same number sent a recent inbound **on the selected OpenWA connection**. No cold outreach.
5. Authorize the exact canonical OpenWA recipient in its connection-scoped Pilot allowlist. Keep `manual_paused=false` only on that TEST session, `pilot_enabled=true` and caps `hourly<=1`, `daily<=1`, `first_touch_daily<=1` while testing. Confirm cohort admission for `workload=agent`.
6. Prepare an eligible Coverage Request and a published `coverage.sourcing@2` Task binding on the agent, with `maxTargets=1`, `maxAttemptsPerTarget=1`, no follow-ups, scoped target contact, valid dry-run and budget caps.
7. Verify approved template remains required for any Meta execution. Do not use placeholder template rows to simulate Meta approval.

## Operator-controlled live sequence

- Explicitly activate only the TEST account cutover through the existing confirmation-gated RPC/test. Do not edit Production or global default flags.
- Create **one** manual Coverage Task in `Agents → مهام الوكلاء`, explicitly selecting that OpenWA session (or an authenticated latest inbound matching that session).
- Inspect the durable reservation before dispatch: `connection_id`, `provider=openwa`, `message_kind=text`, unique idempotency key, no more than one Target.
- Let only the Agent Task worker perform one bounded send. Capture local `message.id`, provider message ID, transport audit `workload=agent`, received TEST phone evidence; do not replay/duplicate even on timeout.
- Send a reply from the same TEST phone; verify signed webhook, replay/dedup, one inbound CRM message, reply-to-Task correlation, opt-out/stop where applicable. Record resulting Task Target state.
- Immediately rollback cutover to `disabled` with the existing confirmation-gated mechanism. Verify outbound_task_delivery_enabled=false, channel scope disabled, count zero active/sending, no accidental queued sends. Leave inbound running. Pause or restore OpenWA pilot controls to their prior safe state.
- Record precise GitHub HEAD, CI runs, TEST evidence, sanitized message IDs, user approval of the TEST number, and before/after guardrail settings on SOF-63.

## Updated readiness (2026-11-14)

- Hosted TEST now has one **ready, non-archived** OpenWA connection for the Phase 18 account. Confirm gateway-native session status before operator activation; database `ready` alone is not sufficient.
- Published `Phase 18 Coverage Pilot` revision #4 has both `coverage.sourcing@1` and `@2`; cutover mode remains `disabled` with no nonterminal Tasks or reconciliation.
- The OpenWA Pilot admin controls previously granted only `manual` workload, which cannot authorize an Agent Task (`workload=agent`). The new `grant_agent` action is explicitly admin-approved on TEST, requires verified same-session inbound within 24h, strict 1/hour + 1/day limits, and creates only one hashed `agent` allowlist row. The normal manual grant path remains unchanged.
- Pilot sequence: get a fresh inbound from the owner's test number, select the existing ready OpenWA session, choose **Enable Pilot** (pauses sends), verify gateway, prepare if needed, set limits to hourly=1/daily=1/first-touch<=1, enter that consented number, then select **اعتماد رقم اختبار الوكيل (agent)**. Verify the status says `approved_workload=agent`, `active_admissions=1`, and `paused=true` before considering activation.
- **Operator authorization is still required** for enabling the OpenWA pilot, unpausing it and activating the separate Agent Task cutover. Do not confuse whitelisting a recipient with permission to send.
- The test phone must also be the **sole eligible Coverage supplier target**, not merely any contact that has chatted. Verify eligibility/target scope before Task creation; choosing `maxTargets=1` alone does not prove the right recipient was selected.
- A recorded real send, reply/opt-out correlation, no duplicate and rollback are mandatory to close SOF-63. Do not activate or send while any prerequisite is missing.

## Historical blocker (observed 2026-11-13)

At that time the inspected TEST account had no non-archived OpenWA connection in status `ready`; its only current OpenWA connection was `disconnected`. The provided account also has no active Agent Task deliveries or authorized TEST recipient evidence in this conversation. **Do not activate or send until this changes.** Keep SOF-63 Backlog / blocked, irrespective of green CI.

## Acceptance result criteria

SOF-63 is **live acceptance complete** only with one real approved TEST send, real reply correlation, verified no duplicate and rollback. Green dry run, DB smoke or local template tests alone do not satisfy it. NOTE-001 security debt still precludes a general Production-ready declaration.

## Local-development worker gap — scoped operator tick (2026-11-14)

`POST /api/agent-tasks` persists a queued Task; it does **not** process the queue or send WhatsApp. `npm run dev` does not automatically run the CRON-authenticated `/api/internal/ai-agent-worker` endpoint. That generic worker also handles unrelated approved change requests and customer notifications and **MUST NOT** be called manually as a shortcut during this one-target pilot.

Observed hosted TEST Task: `86e1cbc3-4d2b-4f1f-8f81-45fd64889c1d`, `status=queued`, `attempt_count=0`, no Target, no Run, no Reservation and one `task.created` event. An unrelated approved change request exists; the new scoped operator command deliberately does not process it.

Opt-in script `npm run test:agent-task-one-target-live` has two independent steps. Both require the exact TEST Supabase URL, service role, one expected account + Task ID, published `coverage.sourcing@2` with `maxFollowups=0`, exact consented contact/connection, one hashed `workload=agent` grant with fresh same-connection inbound, OpenWA Pilot one/day caps, `Cutover=pilot` and no ambiguous reservations. It explicitly rejects any other due Task/queued outbound run globally because the underlying work-claim RPCs are globally scoped. It does NOT invoke the generic Worker or unrelated change requests.

**Stage 1 — Prepare only, no WhatsApp transport:**

```powershell
$env:WACRM_AGENT_TASK_CUTOVER_ACCOUNT_ID = "8ed95309-96cd-4347-b725-bd8c5039ed4f"
$env:WACRM_AGENT_TASK_ONE_TARGET_TASK_ID = "86e1cbc3-4d2b-4f1f-8f81-45fd64889c1d"
$env:WACRM_AGENT_TASK_ONE_TARGET_LIVE = "1"
$env:WACRM_AGENT_TASK_ONE_TARGET_STAGE = "prepare"
$env:WACRM_AGENT_TASK_ONE_TARGET_CONFIRM = "PREPARE_ONE_TARGET_NO_SEND"
npm run test:agent-task-one-target-live
```

Verify exactly one accepted Target, one `queued` outbound Run, **zero reservations/sends**; fail closed otherwise. If the worker fails, inspect DB events, do not create another Task.

**Stage 2 — Sends actual WhatsApp message** only with explicit operator authorization after inspecting stage 1:

```powershell
$env:WACRM_AGENT_TASK_ONE_TARGET_STAGE = "send"
$env:WACRM_AGENT_TASK_ONE_TARGET_CONFIRM = "SEND_ONE_TARGET_TEST_NOW"
npm run test:agent-task-one-target-live
```

For Coverage V2 this second invocation invokes the **deterministic, domain-owned** message policy without generating model text, and **may send a real WhatsApp message**; other task types retain their model execution. It requires exactly one due outbound run, exactly one matching Target and zero reservations, so it cannot be repeated if a send becomes ambiguous. If `requires_reconciliation`, do **not** repeat; inspect official message/provider event and reconcile. Follow with real reply/Task correlation and the separately confirmed `ROLLBACK_TEST` command. Pause/revoke Pilot after verification.

This operator-only TEST command is **not** a production scheduler. A dedicated recurring worker/cron service and workflow operational controls are required for unattended queues after live acceptance, not an unscoped UI auto-dispatch side effect.

## Second TEST attempt after deterministic handoff fix — 2026-11-14

The **first** TEST Task `86e1cbc3-4d2b-4f1f-8f81-45fd64889c1d` was properly finalized by operator after a *pre-reservation* model handoff. Status `partially_completed`, single Target `exhausted`, single Run `failed`; zero WhatsApp reservations. Do not select/retry this Task. The original `013d52e8` request and old scripts above are historical.

A separate isolated, active **second** TEST Coverage Request `82e81d51-7a14-4d83-91cc-b8b40534f7d0` was created inside the *same sandbox-only service* `4648674f-8107-424c-aa63-b2e6c78f81df`: 100 SAR, exactly one matching historical supplier, no active business-event delivery. The selected contact remains only the verified owned TEST recipient; no other real contacts/requests are eligible for this service. The live test command explicitly freezes these exact TEST account/service/request/contact/session IDs and checks the request note, service, currency, amount, recipient, historical supplier and same-session hashed `agent` allowlist before processing.

**Operator UI step** after latest CI succeeds: select Phase 18 Coverage Pilot, new request `82e81d51` (100 SAR), the existing OpenWA TEST session, and **only** the eligible own-number CRM contact; use `maxTargets=1` and `maxAttemptsPerTarget=1`. Click Create once; if an existing Task is returned, do not repeat. `POST 201` means created/queued, not sent. Obtain the resulting Task ID from WACRM or a scoped TEST database query.

**Scoped prepare command** (requires exactly one due Task globally; no WhatsApp send):

```powershell
git switch refactor/service-platform-v2
git pull --ff-only origin refactor/service-platform-v2
$env:WACRM_AGENT_TASK_CUTOVER_ACCOUNT_ID="8ed95309-96cd-4347-b725-bd8c5039ed4f"
$env:WACRM_AGENT_TASK_ONE_TARGET_TASK_ID="<NEW_QUEUED_TASK_UUID>"
$env:WACRM_AGENT_TASK_ONE_TARGET_LIVE="1"
$env:WACRM_AGENT_TASK_ONE_TARGET_STAGE="prepare"
$env:WACRM_AGENT_TASK_ONE_TARGET_CONFIRM="PREPARE_ONE_TARGET_NO_SEND"
$env:WACRM_AGENT_TASK_CUTOVER_ACTIVATE_LIVE="0"
$env:WACRM_AGENT_TASK_CUTOVER_ROLLBACK_LIVE="0"
npm run test:agent-task-one-target-live
```

Inspect the one Target and one queued outbound Run plus zero reservations **before** considering `send`. Stage `send` must again be explicitly confirmed and only run once after gateway-native connection verification, live grant not expired, inbound within 24h, and zero uncertain results. The previous test's failure must never be mistaken for success.

The new worker source is an intentionally exact-ID-bounded operator TEST acceptance command, **not a generic task scheduler or production rollout mechanism**. Do not invoke the general AI worker because unrelated approved change requests remain outside SOF-63's scope.

## Third isolated TEST attempt — temporary contact cooldown (2026-11-14)

The operator's second `prepare` for Task `37be3db6-8f09-4c58-98db-95394c74f330` failed with `materializedTargets=0`, not because no supplier history existed. Hosted TEST task events show `task.claimed` followed by `task.partially_completed` with misleading reason `no_supplier_candidates`, **zero targets, zero runs and zero message reservations**. The exact SQL `materialize_agent_task_contact_target` contact guard rejected the sole selected supplier due to `contact_cooldown` of **60 minutes** from previous TEST Target's last attempt at 2026-11-14 **14:11:31 UTC**. Cooldown ended at **15:11:31 UTC** (18:11:31 Yemen local). Prior Test Task has no real send.

**Safety correction:** The orchestrator now distinguishes `considered>0, accepted=0` with *all* temporary admissions denied (`contact_cooldown`, `account_hourly_contact_limit`, `agent_daily_contact_limit`) from genuinely zero supplier candidates. It records a sanitized, temporary deferral and uses the existing `release_agent_task_claim` with an appropriate minimum delay rather than terminalizing the Task. SQL remains the authority on cooldown/quota and tenant scoping. Permanent rejection (`suppressed`, `contact_not_found`, segment denial, etc.) still fails closed and does not become an automatic send. The scoped TEST operator's `prepare` stage also checks contact's previous Target timestamps against the frozen `cooldownMinutes` **before claiming the Task**, and blocks with a clear cooldown-until error; no override or limit relaxation.

Because the second Task was already terminal when this was diagnosed, it **must not be reopened**. A third distinct isolated, active Coverage Request `4bec8b51-3542-4fb1-933c-699408d69e62` was added under the same service `4648674f-8107-424c-aa63-b2e6c78f81df`, 100 SAR, same single owned TEST supplier and verified anti-parallel attributes; **0 active business events / 0 new tasks / 0 reservations at creation**. No live messages were sent. The earlier first/second requests and Tasks remain as audit history.

To avoid repeated source commits for each bounded TEST fixture, the operator test requires `WACRM_AGENT_TASK_ONE_TARGET_REQUEST_ID` at runtime. It still fails closed unless the request is from the fixed TEST account, fixed isolated TEST service, notes starting `[SOF63 TEST ONLY]`, created after initial failure, exactly 100 SAR and active, with only the one historical owned supplier. It refuses a different account/contact/connection, an existing other Task for the Request, nonexclusive due queue, expired `agent` grant or unsigned session window. The historical `finalize_failed` branch remains pinned to the first, already-closed task.

**Operator workflow after exact-HEAD CI succeeds:**

1. Confirm actual OpenWA gateway session and the **current** same-session inbound and single `agent` hashed grant. If grant expired, renew using administrative TEST Pilot controls and another consented inbound; never adjust RLS or treat TEST `ready` alone as gateway proof.
2. Create **one** Task from the UI: `Phase 18 Coverage Pilot` / third Request `4bec8b51` / same `WhatsApp Web TEST` session / own eligible contact, `maxTargets=1`, `maxAttemptsPerTarget=1`. Confirm returned Task ID/HTTP 201. Do not create a duplicate.
3. Run scoped **prepare only**, with both new IDs supplied:

```powershell
$env:WACRM_AGENT_TASK_CUTOVER_ACCOUNT_ID = "8ed95309-96cd-4347-b725-bd8c5039ed4f"
$env:WACRM_AGENT_TASK_ONE_TARGET_REQUEST_ID = "4bec8b51-3542-4fb1-933c-699408d69e62"
$env:WACRM_AGENT_TASK_ONE_TARGET_TASK_ID = "<NEW_QUEUED_TASK_UUID>"
$env:WACRM_AGENT_TASK_ONE_TARGET_LIVE = "1"
$env:WACRM_AGENT_TASK_ONE_TARGET_STAGE = "prepare"
$env:WACRM_AGENT_TASK_ONE_TARGET_CONFIRM = "PREPARE_ONE_TARGET_NO_SEND"
npm run test:agent-task-one-target-live
```

Expected: `SOF63 PREPARED: one target, one queued run; no WhatsApp send.` Inspect TEST DB and wait for a separate operator-authorized `send` and receipt/reply/rollback. **Never run the general AI Worker** (unrelated approved change requests are out of scope). If preflight or the single Tick fails, do NOT repeat until checking actual Task/Run/reservation state. Mark SOF-63 live acceptance complete **only** after recorded real send, reply correlation, no duplicate and rollback evidence.

