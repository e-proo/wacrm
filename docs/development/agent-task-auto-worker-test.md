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
