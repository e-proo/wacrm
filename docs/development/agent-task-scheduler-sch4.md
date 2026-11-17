# SCH-4 — Agent Task Scheduler recovery and TEST monitoring

This extends the **existing** TEST-only `/api/internal/ai-agent-task-worker`
(no second scheduler, provider adapter or CRM pipeline). The work is part of
SOF-18's fixed-UTC/elapsed-minute scheduler; no calendar/DST semantics.

## Execution / opt-in

- Local `npm run dev` already starts one 15-second TEST-only loop
  (unless `WACRM_DEV_AGENT_TASK_WORKER=off`), using `CRON_SECRET`.
- The optional GitHub Actions `SCH-4 TEST Agent Task Scheduler` calls that
  **same** endpoint every 5 minutes, and is **disabled by default**:
  repository variable `WACRM_SCH4_TEST_SCHEDULER_ENABLED` must be exactly
  `true`. Set `WACRM_SCH4_TEST_WORKER_URL` to the **HTTPS full path**
  `https://<TEST hostname>/api/internal/ai-agent-task-worker` and secret
  `WACRM_SCH4_TEST_CRON_SECRET` equal to TEST `CRON_SECRET`.
  GitHub cron only picks up workflow definitions from its *default branch*;
  the code on `refactor/service-platform-v2` does not mean cron is running.
  Use manual workflow dispatch where available or arrange an approved
  scheduler on the correct deployed branch. Do **not** activate the cron
  while live acceptance is deferred.
- This endpoint is `isOpenWATestProject()`-guarded (actual Supabase TEST
  identity), constant-time bearer checked and bounded to two per stage.
  It can process existing Task/Outbound work if **explicitly enabled**;
  it must not be invoked just to test health. TEST account
  `task_worker_enabled`, cutover, approval, recipient Pilot admission,
  message budgets, RLS, transport reservation and ambiguity reconciliation
  remain authoritative.
- No Production deployment, cron enable, TEST worker invocation or
  WhatsApp send is part of SCH-4 engineering validation.

## Durable lease and crash recovery

Migration 192 creates service-role-only `ai_agent_task_scheduler_heartbeat`.
`begin_agent_task_scheduler_tick` provides one **cross-process** 120-second
lease for the shared TEST Task worker; a competing tick gets HTTP 202
`busy`. `finish_agent_task_scheduler_tick` accepts only the exact owner,
sets a bounded redacted result and clears the lease. If the process stops
ungracefully, the lease expires; subsequent ticks reclaim it. This does
not override per-firing claim generation/unique Task identity or ever
blindly resend a provider-ambiguous outbound. A 200 is processing evidence,
**not** a WhatsApp delivery receipt.

## Health and alert thresholds

An authorized `agents.manage_tasks` account admin can read
`GET /api/agent-tasks/triggers/health`, which invokes tenant-scoped
`inspect_agent_task_schedule_health(account_id)`. It reports only
counts, timestamps, lag, backlog cap, stale lease count and a global,
PII-free TEST runner heartbeat (no phone numbers, event payload, model
prompts, tokens or error strings).

- `staleClaims > 0`: a firing lease is overdue and must be reconciled.
- `dead > 0`: review terminal failure; **do not resend WhatsApp blindly**.
- `backlog >= 80% of cap`: review schedule catch-up / failed claims.
- `dueLagSeconds > 300` or `backlogLagSeconds > 300`: delayed work.
- `runnerConsecutiveFailures > 0`: investigate generic worker error.
- `runnerLastSucceededAt` older than 15 minutes, or no heartbeat while
  runnable scheduling work exists: no recent verified worker progress.
- A paused account or no runnable schedule is not automatically an outage.

The dashboard health pane is read-only and does not restart workers.
For a stop, use existing TEST controls and verify unsettled Tasks and
outbound reconciliation independently.

## Verification evidence and remaining gates

- Migration CI: additive 192 + transactional `agent-task-scheduler-health-smoke.sql`.
- Application CI: HTTP 401/403/503, lease-busy 202, crash exception
  finalization, stale-owner rejection, tenant-scoped health, no PII.
- Dedicated Supabase TEST: apply 192 only after CI; run read-only postchecks.
- **Live acceptance deferred:** SCH-AC-01..11, authorized operator,
  real worker start, provider receipt and restart acceptance.
- Production ready remains NO; NOTE-001 security work and a separately
  operated, alerted/monitored scheduler are still required.
