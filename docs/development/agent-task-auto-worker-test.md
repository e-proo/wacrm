# Automatic Agent Task execution — local pinned TEST (2026-11-15)

## Diagnosis

TEST task `f54c1176-1dbd-4472-ba57-e405043eb51c` was created
15 November 2026 13:47 UTC, `coverage.sourcing@2`, queued and due with
three explicit CRM contacts. It had only `task.created`, no Target
materialization and no outbound Run. This is a missing scheduled worker:
creating the durable task is not the same as running it.

## Behavior added

`npm run dev` launches the normal Next.js development server **and** an
independent local Node timer which requests the dedicated, secret-protected
`POST /api/internal/ai-agent-task-worker`. The timer is enabled only if
`NEXT_PUBLIC_SUPABASE_URL=https://pqirsnfupofhulmewakq.supabase.co`
and `WACRM_DEV_AGENT_TASK_WORKER` is unset or `on`.
Use `WACRM_DEV_AGENT_TASK_WORKER=off` in `.env.local` to opt out and
restart. Unknown values fail closed.

The runner loads `.env.local` through Next's env loader, inherits
or generates a **process-local random** `CRON_SECRET` for Next and the
local timer (never logs it), and sends requests only to `127.0.0.1`.
It starts only a bounded 2-item-per-stage Task trigger, Task orchestrator
and Task outbound tick; no automatic approved Change Request execution,
customer Business Event dispatch or inbound AI recovery. One local timer
does not overlap its previous tick; SQL leases and idempotency coordinate
possible separate instances. It retries every 15 seconds. No migration
and no direct WhatsApp adapter call in this runner.

The Task Orchestrator and Outbound Worker additionally defer pinned TEST
OpenWA Task/Run claims when the **exact session is paused**, or any
explicitly selected recipient lacks either (a) verified recent session inbound
or (b) an explicitly attested phone-call WhatsApp opt-in plus a scoped, unexpired
hashed `agent` Pilot grant. This avoids wasting the only
attempt before approval. The actual send pathway rechecks all normal
transport, tenant, consent/suppression, budgets, message reservation and
ambiguous-outcome rules. Meta and non-TEST behavior are unchanged.

The Agent Tasks UI polls GET `/api/agent-tasks` every 15 seconds while
there is a queued/scheduled/running task; this is read-only.

## Local operator checklist

1. `git switch refactor/service-platform-v2`; `git pull origin refactor/service-platform-v2`; stop old `npm run dev`; `npm run dev`.
2. Verify startup log `[WACRM TEST] Agent Tasks auto-run every 15 seconds`.
   If TEST URL differs, it correctly reports disabled and does not run.
3. For the existing queued three-contact Task, the bound OpenWA connection
   was `02527740-9806-45ae-b9b1-1354c25f1d3f`, **paused** with
   **zero** active agent recipient grants when checked. Review session
   identity, confirm that every intended recipient explicitly agreed to WhatsApp contact
   (including opt-in confirmed by phone call for first-time prospects),
   approve the exact three-number cohort using its appropriate consent basis
   in TEST Pilot (hashed, expiring),
   then explicitly Start session. Do not disable anti-abuse protections.
4. Verify Task acquires target/run claims with no duplicates and every
   authorized WhatsApp receipt/reply and reconciliation is correlated.
   Use Pause/Stop if unsure; never blindly replay ambiguous sends.
5. To stop automatic task processing without altering the CRM, set
   `WACRM_DEV_AGENT_TASK_WORKER=off` and restart. The account-level
   Agent Task Cutover stop is a separate *immediate outbound* control.

## First contact by phone-call consent (TEST only)

- Operator may explicitly attest that each recipient agreed **to WhatsApp messages** in a phone call; a phone conversation alone does not establish consent.
- In session settings > OpenWA Agent Pilot, select the exact cohort, check explicit telephone WhatsApp opt-in, choose `agent`, and approve. No inbound WhatsApp message or existing CRM contact is needed to **approve the pilot recipient**.
- In the Task creation picker, an operator can add a previously unknown normalized international telephone number; the server atomically handles the selection in the existing account-scoped CRM identity path by creating or reusing a CRM contact. This does not send or approve that number in Pilot.
- The new additive migration `166_openwa_agent_phone_call_consent.sql` adds a short-lived consent basis and limits the exception to account + exact OpenWA connection + canonical recipient. Existing Meta Cloud template/session policies, STOP, suppression, budgets, anti-abuse limits, reconciliation and no-blind-resend remain in place.
- Verified-inbound Pilot approval still requires the existing 24-hour chat evidence. Telephone consent is a separate explicit route, not a broad override.
- **Do not start the paused session** or consider SOF-66 live accepted until the operator has reviewed all 2–3 recipient approvals and run the bounded acceptance checks.
- **TEST group caps before approval:** the default `first_touch_daily_cap=1` does not permit a batch of 2–3 new numbers. The session hourly/daily, warmup, selected workload and first-touch caps must all cover the exact cohort count. In OpenWA Agent Pilot, select the recipients first, use **تجهيز حدود الوكيل لـ N أرقام**, explicitly review the suggested values in **الإعدادات المتقدمة**, then press **حفظ الحدود** while paused with no active grants. The suggestion only fills fields; it does not save, grant or start the Pilot. The server gives `pilot_cohort_caps_insufficient` and identifies missing cap fields instead of a generic English warning.
- Example for a three-number TEST cohort on a session with saved limits hourly 3 / daily 10 / first-touch 1 and legacy agent/manual caps 10/30: suggested shared hourly 3, daily 10, first-touch 3, agent hourly 3/daily 10, manual hourly 3/daily 10. Warmup follows the shared caps on save. **Do not set uncapped limits**; the configurable TEST-only session ceiling is now 100/hour, 1000/day (migration 167), but defaults remain 3/hour, 10/day. First-touch max 10 new recipients/day and minimum 15-second pacing remain; use smaller values for live acceptance. The 1000/day ceiling does not expand a per-session 10-recipient grant or authorize unsolicited numbers.
- If any prior recipient grants remain active, the existing limits action rejects changes until the admin explicitly stops Pilot (which revokes all existing grants). Review the exact group and reapprove; never silently revoke or auto-start.


## 2026-11-16 — Dynamic Pilot admission: recipients × messages per recipient

- **Fixes the confusing 3/10 admission notice:** the selected cohort now has an explicit, admin-editable `messages_per_recipient` planning value (defaults to **3** for new batch approvals). For N chosen recipients and M messages each, the TEST Pilot admission floor is **N×M** for session hourly/daily, warmup hourly/daily and the chosen `agent` or `manual` workload hourly/daily limits; **first-touch stays N identities**, not N×M messages. Example: 3 contacts × 3 messages = 9 shared/workload/warmup, with first-touch at least 3. For 5 contacts × 4 messages, capacity floor is 20, first-touch floor is 5.
- The UI shows the actual saved session/agent limits and the calculation, suggests minimal bounded limits, and requires an **explicit Save** while paused, then exact recipient grants, then Start. A session already at 100/hour + 1000/day remains at those caps; no fixed reset to 3/10. Press Refresh to reload current database settings rather than relying on an old browser snapshot.
- New additive `168_openwa_pilot_cohort_message_capacity.sql` records M on each scoped, hashed approval row. **Legacy grants get M=1** to preserve existing approvals; new `grant_batch` defaults to M=3, and the old single-grant API uses M=1. Before lifting pause, the API rechecks actual active grant count, a uniform saved M, and all relevant caps, again after gateway status validation. A plan requiring more than 100 messages/hour is rejected rather than weakening limits.
- This is **capacity planning, not a per-contact delivery guarantee**; it does not cause or authorize messages, override consent/opt-out, modify first-touch frequency, change provider reconciliation or bypass task/account policy budgets. It does not alter the active TEST session, grants or production data.
- Validation: `pilot-cohort-caps.test.ts`, protected Pilot API tests, `openwa-pilot-cohort-message-capacity-smoke.sql` in Migrations CI, TEST migration evidence and latest-HEAD CI must pass before live acceptance. This change alone does not close SOF-66 or approve any rollout.

## 2026-11-15 — Queued outbound Runs despite successful 200 worker ticks

- The local endpoint returning `200` means the worker tick completed; it **does not** mean it reserved or delivered a WhatsApp message. Its `triggers/tasks/outbound` counts determine progress.
- TEST Task `f54c1176-1dbd-4472-ba57-e405043eb51c` progressed to **3 Targets + 3 queued outbound Runs**, with **zero durable outbound messages**. The three Runs were due, unused (`attempt_count=0`), and correct for the **AI model** provider; all three chosen contacts had valid scoped phone-call consent on the selected OpenWA connection.
- **Root cause:** `ai_agent_runs.provider_connection_id` references `ai_provider_connections`, whereas the pinned **WhatsApp transport** is stored in `ai_agent_tasks.target_policy.whatsappConnectionId`. The TEST-only preclaim in `src/lib/ai/tasks/outbound-worker.ts` previously used the model-provider UUID as the WhatsApp connection, which caused `connection_not_ready` and deferred every Run, even though the already-correct SQL reservation resolves the Task transport separately.
- **Fix:** use the existing `resolveTaskMessageConnection` with the frozen account-scoped Task policy and target conversation for the **TEST-only preclaim**. Keep the Run's AI provider untouched for `loadAgentExecutionRevision`, preserve Meta / non-TEST behavior, and keep the SQL reservation and transport check authoritative. On unavailable transport or lost approvals, leave the Run `queued`, without consuming an attempt or blind resending.
- **Observability:** the dev timer now logs a non-zero `outbound.gated` status on changes and periodically (not at every poll), including `queuedOutbound`, `attempted` and `sent`. Never infer delivery from HTTP status alone.
- No migration, provider/connection edit, task reset, grant change, or actual WhatsApp send is part of this patch. **Operator should verify the exact three opt-ins before updating and restarting:** with the Pilot and worker active, the corrected code may now attempt those already-approved queued Runs automatically.

## Deployment boundary

The local runner is not a production service. `npm run start`,
serverless deployment and any non-TEST Supabase project do not run it.
A production environment requires a separately managed recurring
`POST /api/internal/ai-agent-worker` with `CRON_SECRET` and
uptime/alerting/reconciliation evidence before production readiness.

## Verification status

Implementation and unit tests must pass CI; then operator must restart
the actual local TEST server and capture real Target/Run/outbound evidence
before claiming live acceptance for SOF-66/Phase 18/19.
