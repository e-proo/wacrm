# Automatic Agent Task execution — local TEST only (2026-11-15)

## Diagnosis and scope

One Coverage Task `f54c1176-1dbd-4472-ba57-e405043eb51c` on the
pinned TEST project was `queued`, `available_at <= now`, with only
`task.created` in `ai_agent_task_events`, zero Targets and zero outbound
Runs. No competing task caused the wait; creating a Task and processing its
durable queue were intentionally separate. Previously `npm run dev` did not
start a Task worker, so operators had to call the protected endpoint or
run a terminal-based live test to make progress.

## Implemented local workflow

- `src/instrumentation.ts` starts a bounded worker on a **long-running
  Next.js Node.js development server** pointing to the exact authorized
  Supabase TEST URL `https://pqirsnfupofhulmewakq.supabase.co`.
- Startup is automatically enabled for that pinned TEST environment and
  explicitly disabled elsewhere. Set `WACRM_DEV_AGENT_TASK_WORKER=off` in
  `.env.local` and **restart** to opt out. Unknown mode fails closed.
- A single-process scheduler runs `processAgentTaskTriggerQueue`,
  `processAgentTaskQueue`, and `processAgentTaskOutboundRunQueue`
  in order, every 15 seconds, at most 3 items per phase per tick. No overlap
  within a process; SQL leases, idempotency and safeguards coordinate
  multiple workers and restart recovery. A failed tick does not grant a
  new send attempt outside existing durable retry/reconciliation rules.
- Does **not** call the general worker for approved Change Requests,
  Business Event notifications or inbound recovery. It does not dispatch
  WhatsApp directly. Existing outbound gate, per-target consent and opt-out,
  Pilot allowlist per session and workload, queue quotas, pause/circuit
  breakers, business hours and reconciliation continue to apply. Starting
  Next.js automatically *can* send already approved queued Tasks.
- Task list performs a quiet read-only status refresh every 15 seconds
  while it contains queued/running/scheduled work; the manual refresh
  button remains available. The browser does not run any worker itself.

## Environment and deployment

```powershell
git switch refactor/service-platform-v2
git pull origin refactor/service-platform-v2
npm run dev
```

No separate test harness or second terminal is required. Verify that Next
logged `[TEST Agent Task auto-worker] enabled`. If missing, confirm
`NODE_ENV=development`, the exact TEST URL, `WACRM_DEV_AGENT_TASK_WORKER`
not `off`, and a running persistent Node.js server; do not bypass gates.

**Non-TEST and production:** instrumentation never starts this loop.
A production deployment must run a separately managed protected cron job
against `POST /api/internal/ai-agent-worker` using `CRON_SECRET`, with
an uptime/alerting/reconciliation policy before production acceptance.
Do not assume a serverless Next.js instance runs background timers.

## Operator acceptance (NOT yet done)

1. TEST-only authenticated operator confirms task id and selected target
   identities, all active account/provider/recipient Pilot approvals, consent,
   and daily caps. No blanket outbound authorization.
2. Restart `npm run dev` and observe exactly one bounded tick at a time;
   verify Task leaves queued as policy allows, and Targets/Runs are each
   created exactly once.
3. Verify each actual authorized WhatsApp receipt, reply routing, opt-out,
   handoff, anti-duplicate replay and ambiguous-send reconciliation.
4. Disable `WACRM_DEV_AGENT_TASK_WORKER=off` and restart to confirm queued
   work no longer auto-advances; confirm the account Cutover stop button
   blocks **new** deliveries even while the dev worker is running.
5. Capture HEAD, CI run and TEST event/Target/Run/transport evidence before
   closing SOF-66 or Phase 18/19. NOTE-001 security debt is separate.
