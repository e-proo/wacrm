# WACRM — Phase 13 / SOF-18: Scheduling & Business Event Triggers execution and TEST acceptance

**Status:** Engineering plan / pre-implementation audit; no scheduled outbound or Production activity authorized.  
**Repository/branch:** `e-proo/wacrm` / `refactor/service-platform-v2`. **Reviewed code baseline:** `779c7910677049dd5a62394440861a1e9051c513` ([CI success](https://github.com/e-proo/wacrm/actions/runs/44005517505), [relevant migration CI success](https://github.com/e-proo/wacrm/actions/runs/44000513145)). **Date:** 2026-11-17.  
**Linear:** SOF-18 — Phase 13; depends on SOF-17.  
**References:** [Master V1 roadmap](10_AI_AGENT_TASK_AND_OUTREACH_PLATFORM_V1.md), [Phase 12/20 Promotion plan](21_SOF17_SOF25_SERVICE_PROMOTION_EXECUTION_PLAN.md), `docs/development/agent-task-auto-worker-test.md`.

## 1. Outcome, constraints and invariant

Allow authorized WACRM admins to create one-time and recurring **Task schedules** and opt-in **Business Event → Task** policies using the existing Agent Task Trigger Registry and existing domain-specific Task creation. Each due occurrence or event must produce **at most one** durable Task identity, even under duplicate callbacks, overlapping workers, delayed ticks and retries. No trigger is permission to bypass consent, a published revision, task approval requirements, WhatsApp provider policy or cost budgets.

```text
Admin schedule/policy                         Domain Business Event Outbox
        │                                                │
        └──────────────────┬─────────────────────────────┘
                           ▼
            ai_agent_task_triggers (tenant-owned policy)
                           ▼
          materialize_agent_task_trigger_firings (unique source_key)
                           ▼
          claim_next... (leased, bounded / retry / dead)
                           ▼
     CURRENT_AGENT_TASK_TRIGGER_REGISTRY (domain handler)
                           ▼
           create_ai_agent_task (stable source idempotency)
                           ▼
           generic Task worker → Target → outbound admission
                           ▼
       Meta Cloud OR OpenWA via existing WACRM transport
```

Business Domains **emit an event**, never call the AI runtime directly. Scheduler cannot send WhatsApp directly. Production remains inactive until separate operational approval.

## 2. Existing implementation verified (do not rebuild)

| Existing artifact | Current behavior / boundary |
|---|---|
| `supabase/migrations/124_ai_agent_task_triggers.sql` and additive 125/126 | Tables `ai_agent_task_triggers`, `ai_agent_task_trigger_firings`; one-time/interval-recurring/business-event definitions; tenant/idempotency constraints; event-outbox matching; leases, retry and dead state; service-role-only RPCs |
| `src/lib/ai/tasks/triggers.ts` | Typed schedule/event contracts, validated domain handler registry and service-only create RPC |
| `src/lib/ai/tasks/trigger-worker.ts` | Materialize then claim bounded firings with 120s leases, complete/fail, count, MAX attempts 5 in DB |
| `src/lib/ai/tasks/current-platform.ts` | Registered Coverage V1/V2 and Service Promotion V1 handlers; ownership and matching Task manifest checked |
| `src/lib/services/coverage/agent-task-trigger.ts` | One-time/recurring and allowlisted `coverage.request.created` / `coverage.request.activated` events with source identity validation |
| `src/lib/services/service-catalog/agent-task-trigger.ts` | Service Promotion **schedule only**; promotion Business Event is explicitly unsupported |
| `supabase/ci/agent-task-trigger-smoke.sql`, `src/lib/ai/tasks/triggers.test.ts` | Smoke for once/recurring/event firing, pause/resume and typed registry; this alone does **not** establish live timetable/E2E acceptance |
| `docs/development/agent-task-auto-worker-test.md` and `src/app/api/internal/ai-agent-worker/route.ts` | Local TEST runner can tick Trigger → Task → Outbound; it is not a guaranteed Production scheduler. Account worker switch and process-local timer are separate |

### Audited gaps requiring explicit decisions

1. Trigger administration has no demonstrated equivalent of a complete, polished `/agents` UI or scoped trigger CRUD API; Task creation UI is Coverage-centric. Build against existing registry/RPC, not a second scheduler.
2. Fixed `interval_minutes` recurrence is **not calendar recurrence**. Current schema does not capture IANA timezone / monthly rules / DST policy. Either clearly ship bounded interval-only V1 or implement explicit wall-clock recurrence through additive schema + versioned policy; never silently claim cron/calendar semantics.
3. The materializer advances `next_fire_at` one interval per due sweep. After downtime, old occurrences can accumulate; a bounded **catch-up/coalescing/skip** policy is needed to prevent sudden message bursts.
4. Service Promotion start service checks for another active Task on the same service; a scheduled firing may return that Task and be marked complete. Define `overlap = skip | defer` with **recorded skipped reason** rather than miscounting a new Task.
5. Current DB claim admits pending firings for `enabled` or `completed` triggers (required for already-materialized one-time triggers), not `paused`. Review operator semantics of pause: stop future materialization and pending claims; decide treatment for already-claimed/created tasks separately.
6. One-time trigger is marked completed when **firing materializes**, not necessarily when a Task succeeds. UI must display trigger completion separately from firing and Task statuses.
7. No evidence here establishes sustained external cron, alerts, multi-process lock and TEST business-event live integration. Treat these as acceptance gaps.

## 3. Trigger policy contract

Every rule must be account-owned and explicitly reviewed:
- `trigger_id`, `account_id`, `task_type@version`, immutable published `agent_revision_id` or validated revision binding strategy, `approved_by`, `created_by`, `status`, `effective_from/until`, `policy_version`.
- Schedule: `once` with UTC instant; interval recurrence with `next_fire_at` and fixed minutes. If calendar recurrence is introduced: `timezone` (IANA), local rule, DST nonexistent/ambiguous-hour policy, end condition, max occurrences.
- Business Event: allowed event `type/version`, subject type, account, domain subject validation, permitted JSON filters, source `business_event_outbox.id`, event TTL, causation loop guard.
- Delivery eligibility: account runtime policy, worker enabled, cutover, Task type, active service/request, approval strategy, consent, opt-out, channel/connection and provider budget. Registry-level validation and DB materialization recheck both required.
- `overlapPolicy`: `skip` or `defer` when previous Task for the same campaign/request is active. Distinguish `skipped`, `failed`, `dead`, `completed` with one durable firing outcome.
- `catchupPolicy`: finite `skip_missed` / `coalesce_latest` / bounded `replay` (default conservative), `maxFiringsPerTick`, `maxPendingPerAccount`, `maxBackfillAge`.
- Event filter options must be narrow and whitelisted; arbitrary JSON-path expressions, tenant IDs from model output and free-text event-to-action rules are forbidden.

**Source identity:** `(trigger_id, schedule_occurrence_utc)` for schedule and `(trigger_id, business_event_id)` for event → unique `source_key` in DB; Task `idempotency_key` includes the same stable source. Canonical event version/subject validation prevents cross-domain collision.

## 4. Delivery phases

### SCH-0 — Baseline verification and written contracts
- Read current HEAD, all relevant migrations and SQL policies, Task service creators, Event Outbox contracts and actual worker deployment. Map trigger → firing → Task → target → message and each unique constraint.
- Record exact existing `SOF-18` DoD/CI evidence. Decide interval-only V1 vs additional calendar recurrence as an explicit release scope before changing schema.
- Document stop/cancel semantics, DST policy, recovery behavior, no-surprise-catch-up and bound values.

### SCH-1 — Durable policy model and additive migration (only if needed)
- Keep `ai_agent_task_triggers` and `ai_agent_task_trigger_firings` as source of truth; do not create `scheduled_tasks` or second event queue.
- Implement policy versioning/snapshot at firing, immutable approved configuration and at-least-once-safe worker claim. Add only **new** migrations for new columns/unique constraints/state/indices, never rewrite applied 124–126.
- Close race windows around trigger cancellation/pause, lease expiry vs completion, concurrent schedule materialization and fair per-account backlog.
- Add `skipped`/coalesced occurrence accounting as required while respecting existing Task idempotency and tenant isolation; never mark a skipped occurrence as successfully created Task.
- Security: use server authorization before service-role RPC; service-role is not authorization to cross tenants. RLS denial and RPC execute grants tested.

### SCH-2 — Scoped REST + control surface
- Suggested REST surfaces (adapt to existing routes): `GET/POST /api/agent-tasks/triggers`, `GET/PATCH /api/agent-tasks/triggers/[triggerId]`, `GET /api/agent-tasks/triggers/[triggerId]/firings`, `POST /api/agent-tasks/triggers/preview`.
- Admin-only create/edit/enable/pause/cancel, with account-scoped source validation, published agent and permission checks. Avoid arbitrary scheduler execution from client. Public APIs do not return credentials, unredacted inbound messages or internal keys.
- In `/agents`, add **جدولة المهام** view: one-time, every N minutes (interval policy), optional event rules, account-local timezone rendered correctly, next run preview, Dry-run, source/agent/connection, caps, approvals, last 10 firings, clear `skipped/dead` reasons, audit and Pause.
- Show **trigger status ≠ firing status ≠ Task status ≠ WhatsApp status**. A 200 worker tick does not mean a message was sent. No hidden auto-activation after edit.

### SCH-3 — Domain handlers and consent-preserving task creation
- Coverage scheduled/event tasks through `COVERAGE_SOURCING_TRIGGER_HANDLER_V2` with the correct active Coverage Request and explicit provider connection. Do not widen the source requester or contacts.
- Service promotion scheduled tasks through `SERVICE_PROMOTION_TRIGGER_HANDLER`, after SP-0..SP-6 readiness, exact cohort, approved template and no overlap. A `service.lead.created` event **must not** be connected to promotion until a vetted handler supports it; consider separate `service.followup` Task contract if needed rather than repurposing cold outreach.
- Per-occurrence create is idempotent at DB source key. If existing Task is returned, record it as an explicit dedup/overlap outcome, not as a newly started task.
- Never let scheduler set `whatsapp_connections` provider/session credentials or change Meta default; selected connection is frozen in a reviewed Task policy, or safely resolved by account-aware adapter.

### SCH-4 — Worker process, recovery and backlog safety
- Register a single scheduled TEST invocation of the **existing** `/api/internal/ai-agent-worker` protected by `CRON_SECRET` and environment gates; local `npm run dev` timer is TEST-only, not a production SLO. Avoid multiple uncontrolled independent timers.
- Worker is bounded per tick/account, non-overlapping where possible, lease-based cross-process, recover-after-crash with unique firing/Task identity and provider reconciliation.
- Gate execution by `task_worker_enabled`, cutover `mode`, trial cohort, published capabilities, message budgets and qualified targets. A scheduler may persist a Task without permission to send it.
- Add pause/cancel effects: stop future firings and unclaimed work; reconcile already-claimed or in-flight items; do not retroactively delete provider messages.
- Implement observability/alerts for `oldest_due_at`, materialization lag, pending/claimed/failed/dead, leased stale, no runnable worker, per-account skipped and API errors; no PII in logs.

### SCH-5 — Automated coverage / migrations / CI
- SQL smoke: once exactly once, recurring next due, independent periodic occurrence, same event replay, event outbox cross-tenant isolation, allowed subject matching, tenant-scoped creation, pause/resume, disable, status transitions, lease expiry/reclaim, error to dead, overdue coalescing, unique `source_key`.
- TypeScript tests: both domain handlers/versions, invalid event subject/version, wrong service/request, unavailable published revision, overlapping Task semantics, source key stable, Task idempotency and missing connection.
- Race tests: 2 workers claim same firing; event duplicate insertion; crash after Task created but before firing completion; retry must return exact Task, no duplicate Targets/reservations; concurrent pause, clock skew and capped backfill. Prove Meta/OpenWA policies unchanged.
- Calendar if added: timezone conversion, DST spring gap and fall fold, interval vs wall-clock, leap day/end-of-month, edit/re-enable and max-frequency guard. CI on exact HEAD; additive migration applied and inspected in TEST plus clean-replay workflow success.

### SCH-6 — Live TEST acceptance (no unapproved sends)
**Operator authorization prerequisites:** TEST DB/account, consented 1–3 controlled contacts, connection/campaign approved as relevant, independent OpenWA/Meta policy, worker/cutover state and no ambiguous reservations. Use safe dry-run/no-send checks for materialization whenever possible.

| ID | Scenario | PASS condition |
|---|---|---|
| SCH-AC-01 | One-time schedule, before due | No early Task, one audited firing at due, exactly one task with source key |
| SCH-AC-02 | Same interval recurrence across at least two due periods | Exactly one Task/firing per occurrence **or** explicit recorded overlap skip; no cross-period duplicate |
| SCH-AC-03 | Business event `coverage.request.activated` on authorized TEST request | One matching Task, correct source subject/account; disabled rules do nothing |
| SCH-AC-04 | Duplicate event/repeated trigger tick | No duplicate firing, Task or initial outbound reservation |
| SCH-AC-05 | Worker restart / lease reclaim after safe interruption | Same firing and Task ID, no blind resend and no lost work |
| SCH-AC-06 | Pause/disable while next schedule pending | Future materialization/claims blocked as specified; restart preserves status; normal inbound unchanged |
| SCH-AC-07 | Non-eligible/opt-out/outside hours/out-of-budget contact | Scheduled work safely delayed/skipped/blocked with reason; zero illicit send |
| SCH-AC-08 | Cross-account malicious subject/agent/connection and forbidden event | Fail closed (admin API + SQL); no data leak or Task |
| SCH-AC-09 | Catch-up after clock jump/downtime simulation in TEST | Bounded policy applied; no surprise historical message burst |
| SCH-AC-10 | Cutover rollback `pilot → disabled` and post-rollback inbound | No new Task delivery; ordinary CRM inbound works; unsettled outcomes reconciled |
| SCH-AC-11 | Outcome trace | Trigger → firing → Task/Target/Run IDs + reason/timestamp are observable and accurate |

Record PASS/FAIL/BLOCKED, UTC timestamp, exact observed HEAD/CI/Migrations URLs, TEST project/account, Trigger/Firing/Task/Target IDs, event IDs, connection/provider, reconciliation state and reason. **Do not artificially trigger provider sends to prove idempotency**; use CI replay or authorized TEST-only synthetic events.

## 5. Definition of Done and release boundaries

- **Implementation complete (SOF-18):** reviewed trigger policy, account-scoped admin API/UI, domain handlers, safe recurrence/overlap/backlog, audit and rollback, automated negative and concurrency tests. Explicitly distinguish fixed-interval recurrence from calendar schedules if calendar support is deferred.
- **TEST verified:** additive migration, if any, applied and inspected in TEST; security grants/RLS and full CI + migrations clean replay passed on relevant revisions.
- **Live acceptance complete:** SCH-AC-01..11 with operator-signed evidence and no unacknowledged failures, plus no unexpected outbound/cross-tenant behavior. Failure/blocked case means not Done at live level.
- **Production ready:** separately requires durable managed scheduler with uptime/alerting, dry-run rollback, tested secrets/security advisors, NOTE-001 resolution/review and graduated authorization. Local auto-worker's 15-second timer is not this guarantee.

## 6. Suggested execution order and responsibility

**Order:** SCH-0 → SCH-1 → SCH-2 → SCH-3 → SCH-4 → SCH-5 → SCH-6. SCH-0/SCH-1/SCH-2 design and no-send tests may run in parallel with Service Promotion, but enabling actual promotion-triggered sends waits for approved SP gates.  
**Owner roles:** backend/schema (contracts + migrations), frontend (trigger UX), QA (concurrency, regression and live TEST), operator (consent/cohort and rollback), security (tenant/RLS and production gate).

**Stop conditions:** unexpected contact/provider, lost account scope, duplicate Task/outbound, replay producing a new message, ambiguous send without reconciliation, unbounded backfill, scheduled task after pause/kill-switch, invalid event source, PROD access during TEST. On STOP: disable new Task sends, pause worker/trigger, preserve existing messages and evidence, reconcile pending, then retest.
