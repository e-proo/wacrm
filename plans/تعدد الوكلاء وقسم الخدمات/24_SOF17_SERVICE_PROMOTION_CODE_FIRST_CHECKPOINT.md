# SOF-17 / Service Promotion — code-first engineering checkpoint

**Date:** 2026-11-17. **Branch:** `refactor/service-platform-v2`. **Current status:** partial implementation underway; technical CI/TEST gates and live acceptance are not yet signed off. **No production changes or WhatsApp live sends authorized.**  
**Plan:** [21_SOF17_SOF25_SERVICE_PROMOTION_EXECUTION_PLAN.md](21_SOF17_SOF25_SERVICE_PROMOTION_EXECUTION_PLAN.md). **Related:** [SOF-17](https://linear.app/eproo/issue/SOF-17) / [SOF-25](https://linear.app/eproo/issue/SOF-25).

## Operator-approved execution order

**A. Code complete (NO LIVE SEND)** → **B. Technical tests/SQL TEST review and full GitHub CI (NO LIVE SEND)** → **C. Scenario simulation, dry-run, security/recovery audit (NO LIVE SEND)** → **D. Operator-authorized live bounded pilot LAST (SOF-25)**.

Until A/B/C pass, do not activate a promotion campaign, register an enabled scheduled promotion trigger, widen OpenWA Pilot, or test by messaging real contacts. The existing worker and other WACRM functionality are not paused by this documentation.

## Code changes started — SP-1 safety foundation

| Item | File | Implementation detail | Acceptance level |
|---|---|---|---|
| Tenant-owned tags and contacts | `src/lib/services/service-catalog/promotion-audience.ts` | Check tag ownership in `tags(account_id)`; query `contact_tags` through tenant-filtered `contacts!inner` and `tags!inner` joins | Implementation added, CI to verify |
| Deterministic bounded membership | same | Stable sorting, page-wise complete scan, fail closed on oversized audience instead of silently taking LIMIT candidates | Implementation added, CI to verify |
| Frozen recipients at Task creation | `service-catalog/agent-task-service.ts` | Persist exact `frozenContactIds` in `target_policy` and `task_context.segmentSnapshot`; previous active Task can only be reused if campaign source/revision identity matches; stable SHA-256 idempotency key | Implementation added, CI to verify |
| Frozen-only runtime resolver | `service-catalog/agent-task.ts` | Resolver admits only stored recipient IDs, re-checks tenant-owned CRM contacts; legacy rows without snapshot **fail closed** requiring reapproval | Implementation added, CI to verify |
| Initial template candidate (V1-compatible) | same | V1 still selects the registered `service_promotion_v1` template candidate; **existing model-first orchestration is intentionally unchanged** until a versioned provider-aware policy passes technical gates | Existing contract preserved; provider parity still open |
| Read-only preview | `src/app/api/agent-tasks/promotion/preview/route.ts` | Requires task+outreach admin capabilities, finds tenant-scoped service/published agent, returns bounded cohort/opt-out and consent blockers. `readyForLaunch=false`; **no Task, RPC, send or pilot mutation** | Implementation added, API automated tests to verify |
| Readiness consistency | `service-catalog/pilot-readiness.ts` | Passes excluded tags, respects approved `maxTargets`, expresses oversized/unowned audiences as explicit readiness blockers | Implementation added, CI to verify |
| Automated regression | `promotion-audience.test.ts`, `preview/route.test.ts` | Frozen vs legacy, cross-tenant, tag conflicts, pagination, overlimit, RBAC, no-send | Tests added, not yet signed off |

### Security and backward-compatibility decisions

- `contact_tags` has no `account_id`; confirmed from TEST schema. Account predicates must apply to both `tags` and `contacts`. This is **not** solved simply by using `service_role`.
- No new schema/migration in this increment; snapshot uses existing JSONB Task policy/context. No data migration, no edit of an applied migration, no Production modification.
- Historical promotion tasks without an exact member snapshot are denied new target resolution until deliberately reapproved in a new Task. This prevents a widened tag from silently adding new targets.
- Original WACRM Agent Task, tool grants, suppression, Meta/OpenWA adapters and reservation/reconciliation architecture remain authoritative.
- Safety correction: do **not** switch existing `services.promotion@1` from model-first execution to deterministic dispatch in this preparation; such a change could make queued historical tasks send unexpectedly. Introduce an explicit versioned provider-aware policy only after SP-3 safeguards and no-send regression tests.
- Preview is a safety inspection, **not** permission to send. The template provider readiness, explicit operator confirmation, consent provenance, active segment approval, staff takeover and Intent business outcomes remain separate gates.

## Remaining technical work — before any live testing

| Gate | Work required | Evidence |
|---|---|---|
| SP-1 finishing | Review query pagination and tenant joins in real TEST read-only queries; confirm tag match/suppression snapshot, candidate limit, immutable campaign approval, parallel race safety | SQL read-only review + integration test |
| SP-2 | Admin UI service/agent/connection picker, preview confirmation, signed snapshot or stale-preview protection, server-authoritative launch API | API + React UI tests, role/tenant negatives |
| SP-3 | Meta template/status + session window compliance and OpenWA text strategy **by provider**; pin `whatsappConnectionId`; enforce consent and first-touch policy in both SQL reserve and pre-dispatch | Provider matrix tests, no-send dry-run |
| SP-4 | Exact inbound multi-turn Target linkage; native `intents.record@1` persisted once, approved Service Request/human handoff, opt-out/STOP | Full simulated conversation/replay tests |
| SP-5 | Truthful completion: distinct sent/replied/qualified/declined/opt-out/handoff counts and no fake success, campaign observation | Outcome policy tests / SQL traces |
| SP-6 | Full `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, relevant SQL smoke/migrations replay; security, crash/recovery, worker/tenant invariants | successful exact-HEAD CI + TEST evidence |
| SP-7 **last** | Operator explicitly grants controlled 1–3 TEST contacts and signs SP-AC-01..09; verify rollback and post-rollback inbound | SOF-25 live TEST acceptance; **not started** |

## Local developer non-live test commands

```powershell
git switch refactor/service-platform-v2
git pull --ff-only origin refactor/service-platform-v2
npx vitest run src/lib/services/service-catalog/promotion-audience.test.ts src/lib/services/service-catalog/agent-task.test.ts src/app/api/agent-tasks/promotion/preview/route.test.ts
npm run typecheck
npm run lint
npm run build
```

**These commands do not trigger any WhatsApp send or run the local Task worker.** Avoid `npm run dev` for this test pass because its wrapper may enable a TEST worker timer when configured. Run technical tests directly.

## Evidence fields to append before closure

- Actual HEAD + exact CI run/conclusion; lint/typecheck/tests/build counts; relevant SQL TEST read-only result or migration clean replay.
- No-sends preview response, tenant/foreign tag negative, pagination/overlap/consent negative, provider/template compliance and approval enforcement.
- Simulated Intent/opt-out/human handoff and no duplicates after retry.
- Live AC outcomes remain explicitly **NOT RUN** until previous technical gates and operator approval.

**Closure:** SOF-17 remains `In Progress` until all SP-0..SP-6 engineering and CI/TEST proof; SOF-25 remains `In Progress` and live untested. Never conflate implementation with TEST verified, live acceptance, or Production ready. `PROJECT_NOTES.md` NOTE-001 remains separate production security gate.
