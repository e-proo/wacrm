# SCH-5 — Agent Task Scheduling technical regression & closure evidence

**Scope:** WACRM `SOF-18`, `SCH-5` only; branch
`refactor/service-platform-v2`. **Technical verification date:** 2026-11-17
(UTC; SCH-6 operator/live acceptance is deliberately deferred).

## Code and SQL boundaries checked

**Existing architecture preserved:** reviewed schedule/business-event policy
→ `ai_agent_task_trigger_firings` with immutable `source_key` and frozen
`policy_snapshot` → generation-fenced lease → approved domain V2 Task
creator → existing outbound policies. No alternative event queue, worker
or provider integration was added.

**Safety fixes found by SCH-5:**
1. Lost completion/lease ownership had been classified as a successful
   ordinary `failed` transition if the SQL `fail` RPC returned null.
   `trigger-worker.ts` now fails closed with
   `AGENT_TASK_TRIGGER_FIRING_CLAIM_LOST` instead.
2. Handler exception messages were being written into durable
   `last_error`, potentially recording recipient phone numbers or secrets.
   Now only trusted uppercase domain/error codes can be persisted; raw
   untyped exception text becomes `AGENT_TASK_TRIGGER_HANDLER_ERROR`.
3. A process crash on the **fifth** claimed attempt could strand a firing
   as `claimed` with an expired lease: normal claim requires
   `attempts < 5`. Additive migration
   `193_agent_task_trigger_exhausted_lease_reaper.sql` provides a
   service-only, bounded, `SKIP LOCKED` terminal sweep. It changes only
   expired fifth-attempt queue rows to `dead` with a constant reason,
   never touching a Task/Target/provider message, never resending.
   Earlier attempts are still recoverable and active leases untouched.

## Technical test matrix — no provider messages

| Contract / failure path | Verified by | Boundary |
|---|---|---|
| Once before due and exactly-once at due; recurring and coalesced downtime; bounded backfill and account pause | `supabase/ci/agent-task-trigger-smoke.sql` | transactional SQL |
| Duplicate Business Events, wrong subject, wrong event tenant, pause/resume and per-account queue health | `supabase/ci/agent-task-scheduling-sch5-smoke.sql` | synthetic TEST SQL, ROLLBACK |
| Two workers racing to claim one firing and admission at account backlog cap=1 | `supabase/ci/agent-task-trigger-concurrency-smoke.sh` | real concurrent PostgreSQL sessions, isolated CI |
| Two shared scheduler ticks race; crash expiration; stale owner may not finish after reclaim | `supabase/ci/agent-task-scheduling-sch5-race.sh` | real concurrent PostgreSQL sessions, isolated CI |
| Expired fifth claimed attempt → terminal `dead`; fourth retryable; active fifth still protected | `supabase/ci/agent-task-trigger-sch5-exhausted-lease-smoke.sql` | synthetic TEST SQL, ROLLBACK |
| Pause, immutable version/CAS, claim vs edit/cancel, cancelled no-revive, RLS grants | `supabase/ci/agent-task-trigger-policy-lifecycle-smoke.sql`, `agent-task-schedule-policy-smoke.sql`, `agent-task-trigger-reviewed-control-smoke.sql` | transactional SQL |
| Frozen Service Promotion V2 approval, provider/connection/revision/cohort drift, disabled Pilot, idempotent retry | `src/lib/services/service-catalog/promotion-schedule-policy.test.ts`, `agent-task-scheduled-replay.test.ts`, `src/app/api/agent-tasks/triggers/route.test.ts` | no-send Vitest |
| Coverage V2 exact request, subject, account, revision, explicit contacts/provider; registry denies V1 promotion bypass | `src/lib/services/coverage/agent-task-trigger.test.ts`, `src/lib/ai/tasks/triggers.test.ts`, schedule admin route tests | no-send Vitest |
| Crash after Task exists but before firing complete, same Task replay; lost owner fails closed; error payload redaction and `dead` counters | `src/lib/ai/tasks/trigger-worker.test.ts` | no-send Vitest mock with two recoveries |
| TEST-only cron secret, global tick lease, authenticated metrics, heartbeat error/lag thresholds | `src/app/api/internal/ai-agent-task-worker/route.test.ts`, `src/app/api/agent-tasks/triggers/health/route.test.ts`, `supabase/ci/agent-task-scheduler-health-smoke.sql` | no-send API + TEST SQL |
| Meta/OpenWA transport policy preservation | Existing application CI Meta/OpenWA regression suites, no transport adapter modified in SCH-5 | regression, **not** live provider acceptance |

## CI / isolated concurrency

- [Migrations #44192563474](https://github.com/e-proo/wacrm/actions/runs/44192563474):
  completed/success — duplicate Business Event / tenant boundary and
  real two-Postgres-session SCH-5 scheduler race added.
- [Migrations #44193042736](https://github.com/e-proo/wacrm/actions/runs/44193042736):
  completed/success — clean schema replay including migration 193; its
  exhausted-lease SQL smoke and SCH-5 race, event/isolation smoke all passed.
- [Application CI (follow latest branch)](https://github.com/e-proo/wacrm/actions?query=branch%3Arefactor%2Fservice-platform-v2):
  require **completed/success on exact final HEAD** before declaring the
  final application gate passed. A running job is never accepted as success.
- True concurrent PostgreSQL sessions are proven by a CI script using
  `pg_stat_activity.wait_event='PgSleep'` to show actual overlap; the
  hosted TEST SQL connector does not prove a multi-session race.

## Dedicated Supabase TEST / migration ledger

Project: `wacrm test`, project ID `pqirsnfupofhulmewakq`.
Additive migration 193 applied and verified in TEST, ledger version
`20261117224716`. No historical migration was edited.

On TEST, the **exact committed** SQL smoke files
`agent-task-trigger-sch5-exhausted-lease-smoke.sql`,
`agent-task-scheduling-sch5-smoke.sql`,
`agent-task-scheduler-health-smoke.sql`, and
`agent-task-trigger-policy-lifecycle-smoke.sql` were executed inside
`BEGIN; ... ROLLBACK;` and all returned successfully.
Afterward: enabled schedules=0, unsettled firings=0, test auth users=0,
no persisted synthetic exhausted-lease rows.
`authenticated` cannot execute the reaper;
`service_role` can.

This is **TEST SQL verified** and **CI PostgreSQL concurrency verified**;
it is **not TEST end-to-end task delivery**, **not live acceptance**,
and **not Production readiness**.

## Open gates / Live acceptance deferred

`SCH-AC-01`…`SCH-AC-11` remain operator-run acceptance, including
real authorized one-time/recurring due ticks, exact approved 1–3 recipient
cohort, business event, restart in the deployed TEST worker, pause/cancel
with in-flight work, provider/time/budget gates, rollback and WhatsApp
receipt/reconciliation evidence. Missing: operator approval, actual
TEST clock-run evidence, final Task/Target/message IDs and transport receipts.

`SOF-18` must remain **In Progress** until all required DoD and live
acceptance evidence exists. `SCH-5` is **implementation complete** and
**TEST SQL verified**; exact-HEAD Application CI must be checked
independently. Calendar/DST recurrence is not shipped: interval-only UTC
cadence remains the agreed scope. `NOTE-001` is an open Production security
gate. The optional external TEST cron is disabled, and no live send was made.
