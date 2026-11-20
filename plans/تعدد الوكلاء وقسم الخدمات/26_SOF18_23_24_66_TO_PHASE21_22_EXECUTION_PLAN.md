# WACRM — Complete Scheduling + Coverage, then staged Builder Release and Safe Cleanup

**Date:** 2026-11-20 · **Source of truth:** e-proo/wacrm, branch `refactor/service-platform-v2`  
**Program:** Agent Task & Outreach Platform V1 · **Linear:** SOF-18, SOF-23, SOF-24, SOF-66 → SOF-26 → SOF-27  
**Product decision:** SOF-17 / Phase 12 Service Promotion and SOF-25 / Phase 20 Promotion Pilot are DEFERRED. Do not start campaigns, enable their scheduled triggers or use their completion as evidence for Coverage.  
**Current level:** scheduling/coverage code and local CI tests verified, including prior bounded successful Coverage sends, but independent 13-case Coverage cutover and 11-case Scheduler operational acceptance are still OPEN. Phase 21 begins at non-operational contract preparation; Phase 22 is inventory only.

## 1. Actual baseline: HEAD, runtime, SQL and test evidence

- Verified starting branch HEAD `165123addb8e2b149de2ce66e1f97c22522ec9c4`. Application [CI](https://github.com/e-proo/wacrm/actions/runs/44773738872) completed/success at this SHA, [Migrations](https://github.com/e-proo/wacrm/actions/runs/44771991558) completed/success for earlier migration-related code. This proves regressions only; it does not create an operational test record.
- Existing scheduler stack: `ai_agent_task_triggers`, `ai_agent_task_trigger_firings`, `src/lib/ai/tasks/trigger-worker.ts`, `src/app/api/agent-tasks/triggers`, `src/app/api/internal/ai-agent-task-worker`, `src/components/agents/agent-task-schedules-panel.tsx`. SCH-1..5 technical code and rollback-safe SQL/test evidence already exist (see `docs/development/agent-task-scheduling-sch5-technical-acceptance.md`). No second cron or task worker should be introduced.
- Additive SQL migration `193_agent_task_trigger_exhausted_lease_reaper.sql` is applied to Supabase **wacrm test** as migration name `agent_task_trigger_exhausted_lease_reaper` (remote ledger version `20261117224716`), independently rechecked READ ONLY on 2026-11-20.
- READ-ONLY TEST snapshot at the time of this plan: **0 enabled triggers, 2 paused triggers, 0 unsettled pending/claimed firings, 0 queued/running/scheduled/validating Agent Tasks**. 13 Tasks created in last seven days, 4 completed. Totals are not a service KPI or proof of human acceptance and can change. Zero backlog does not prove that an external scheduler or watchdog is running.
- Phase 11 `SOF-16` completed with one genuine Coverage supplier flow; prior one-target `SOF-63` and historical two-target successful Coverage pilot with exact inbound correlation and two approved offers are recorded in `18_SOF16_COVERAGE_SOURCING_ACCEPTANCE.md`, `19_SOF66_TWO_TARGET_LIVE_TEST_CHECKPOINT.md`.
- The current consolidated register `23_SOF66_PHASE18_PHASE19_ACCEPTANCE_EVIDENCE_REGISTER.md` explicitly marks AC-01..AC-13 **not recorded as final signed acceptance**. Therefore SOF-66, SOF-23 and SOF-24 must remain In Progress.
- Supabase TEST is separate from Production. No action here starts a worker, sends WhatsApp, enables a TEST Pilot, modifies the VPS or applies migrations.

## 2. Track A — SOF-18 / SCH-6 closure

**Engineering status:** SCH-1 through SCH-5 implementation + local/TEST SQL verification done. **Remaining:** independent operational SCH-6 evidence, not a new scheduler.

### SCH-6 scenarios / DoD (S01–S11)

| Case | Operator action and proof | Exit |
| --- | --- | --- |
| SCH-AC-01 | Create approved once trigger with worker stopped; verify no early materialization; start one authorized owner tick when due | Exactly one firing and one Task, no extra reservation |
| SCH-AC-02 | Observe two due occurrences of UTC interval recurrence (no DST/calendar promises) | One firing per occurrence or durable bounded skip/defer |
| SCH-AC-03 | Publish authorized Coverage business event from same-account request | Correct one Task/source account/subject |
| SCH-AC-04 | Replay event/tick | No duplicate Task, target, reservation |
| SCH-AC-05 | Stop/restart approved worker after stable, non-ambiguous state; separately simulate lease recovery | Same firing/Task ID, no blind resend |
| SCH-AC-06 | Pause/disable/cancel rule before next due | New materialization/claims blocked; no resurrection |
| SCH-AC-07 | Explicit non-consented/opted-out/outside-hour/budget-exceeded synthetic recipient | Durable skip/defer/block; zero unauthorized send |
| SCH-AC-08 | Cross-account forged request/agent/session or forbidden event | Server + SQL fail closed |
| SCH-AC-09 | Simulate missed intervals/downtime with safe TEST clock values | bounded skip/coalesce; no historical send burst |
| SCH-AC-10 | Pilot → disabled after all prior ambiguous outcomes settled | No new outbound Task send; regular inbound still works |
| SCH-AC-11 | Use Scheduler Health, Trigger/Firing, Task/Target/Run and receipt lineages | Correct, redacted per-step outcome trace |

**Preconditions:** one authorized TEST account; named operator; exact HEAD, relevant Migration CI, checked TEST schema, authenticated admin and capabilities, current trusted contact+connection policy, confirmed **single** worker owner (Windows OR VPS, not both), frozen cohorts, safe STOP/rollback and signed test plan. Read-only/mocked cases can be executed first; real provider operations require an independent explicit authorization and exact consenting controlled recipients.

**Exit:** mark each SCH-AC PASS/FAIL/BLOCKED with UTC timestamps, evidence IDs and operator. Do not close SOF-18 for a 200 worker response or a green CI alone. If any required case is blocked, leave the issue open with a reason.

## 3. Track B — SOF-66 + SOF-23 + SOF-24 consolidated closure

**Reuse the existing documented happy path.** The next work is negative, recovery and human-handoff evidence. Do not resend just to recreate previous successes.

`20_SOF66_PHASE18_PHASE19_TEST_ACCEPTANCE_PACK.md` holds exact AC-01..13 step-by-step. The original evidence register `23_SOF66_PHASE18_PHASE19_ACCEPTANCE_EVIDENCE_REGISTER.md` is authoritative until new signed entries exist.

- **SOF-66** closure: AC-01/02/03/04/05/09/10/12/13 + account and consent negatives. Two or three explicitly authorized recipients with frozen identities, per-target idempotency, pause/resume, opt-out and provider reconciliation. Source contact must not be selected as target.
- **SOF-23 / Phase 18** closure: bounded batch, actual cutover switch to pilot and back to disabled, pause/restart/lease recovery, zero unknown outcomes before restart, post-rollback inbound still accepted. Do not infer this from earlier one-target rollback.
- **SOF-24 / Phase 19** closure: historical successful 2-supplier Coverage cycle **plus** real decline (AC-06), route-change that becomes **review-only** without fabricating a matching offer (AC-07), effective Inbox human takeover that stops AI continuation (AC-08), and honest no-offer/partial task completion (AC-11). Coverage payment/order ledger is a separate Business Domain and is not marked settled merely because Agent Task completes.
- No fake delivered/failed on ambiguous timeout; `closed_unverified` is a supported audited disposition for unknowns, never a delivery claim.
- Meta remains official/default; OpenWA is optional linked-device transport; agents never receive session credentials or choose engine. All inbound, ACK and media reconciliation remain unified. No auto-failover to bypass Meta policy.

### Explicit acceptance signing
Record for every case: exact account (private internal record), frozen target cohort and consent proof (never in a public report), connection ID, agent published revision, Task/Target/Run IDs, provider message IDs or reason codes, UTC time, source commit, observed policy/caps, expected and actual state, redacted log/SQL screenshot, independent reviewer. Treat all absent evidence as **NOT RECORDED**, not PASS.

## 4. Track C — Phase 21 / SOF-26 staged Builder release, coverage-only first

**Important:** The generic Builder already exists and supports normal reactive/inbound agents, outbound settings, published agent revisions, coverage tasks and schedules. Do NOT rebuild the Builder or silently disable existing inbound functionality.

### P21-00: contract and threat model — IN PROGRESS
- Draft new server-side **pure, fail-closed rollout decision** `src/lib/ai/tasks/builder-release-policy.ts`, covered by tests. Default `disabled`; six stages:
  `disabled → internal → owner → selected_accounts → capability_admins → general_availability`.
- Rollout target **only** `coverage.sourcing@2` at initial release. `services.promotion@1/@2`, `fx.outreach`, and `receivables.followup` remain outside acceptance; registering a Task Type in code is not permission to operate it.
- Required proofs before even entering `internal`: SCH-6 signed; Coverage multirecipient, negative outcomes and handoff; rollback; zero unsettled unknown sends; tenant/role security; Meta/OpenWA policy; inbound/reactive Builder parity; RTL/mobile/manual accessibility; Operations incident and rollback owner.
- The decision contract grants **visibility only**; never an outbound transport, publish, agent tool, scope, cutover or recipient permission. No browser-provided role/tenant/evidence can satisfy this contract.

### P21-01: controlled server-authoritative rollout (BLOCKED by Track A+B)
- Create a separately reviewed durable per-account stage + immutable approval audit and exact evidence links, tenant/RLS scoped. Use additive migrations only. No owner/admin capability can bypass the admission of its exact role and account.
- Route **all** newly released outbound Builder surfaces and task-launch entrypoints through that approved stage; keep existing reactive/inbound experience and stable historical tasks unaffected. Include explicit legacy TEST compatibility and security review.
- Cannot advance by setting a frontend feature flag or standalone env variable. Production/GA stage requires distinct GO decision, closed NOTE-001 and other global readiness gates.
- No automatic migration of existing agents, published revisions or tasks; preserve current account controls, destination/recipient consent, Meta template, OpenWA provider activation and TEST Pilot.

### P21-02: professional Builder launch UX (not activated)
- Clean responsive sections: Overview → Agent Profile → Capabilities/Tools → Task Bindings (Coverage-only initially) → Audience & consent → WhatsApp Connection → Budgets/Hours → Simulation → Review → Publish.
- Show **draft vs published revision vs active runtime vs outbound permission** explicitly; never label publishing as sending. Owner/admin capabilities from server, immutable revision, confirmation before outbound capability and audience.
- Accessible Arabic RTL/English LTR, mobile focus/keyboard, read-only blockers, drift warnings, detailed error reasons, no credential/QR display.

### P21-03: telemetry + release rollback
- Per account/stage metrics: create, preview, publish, blocked reasons, task start/complete/failed/opt-out, unknown send reconciliation, lag/backlog, security/audit; redacted PII.
- Operator can regress stage to disabled without deleting agents, tasks, messages or inbound routes. Existing task/worker/pilot STOP remains a **separate** gate. Require exact audit of who approved any transition.
- Internal → owner → selected accounts → capability admins only after a stability observation window with signed stage-specific metrics; do not promise GA before deferred Promotion and OW14 Production gates are finished.

## 5. Track D — Phase 22 / SOF-27 cleanup, inventory only for now

DO NOT delete code before successful Phases 18/19/21 stage acceptance and stability, and before verifying Service Platform transition dependencies. Start a read-only inventory:

| Path / seam | Risk if removed | Policy |
| --- | --- | --- |
| `src/app/api/ai-agents/route.ts` older auto-publish path for existing agent | Existing clients/revisions may rely on it | Inventory exact callers; compare new atomic publish; contract tests before any deprecation |
| `src/lib/ai/runtime/agents-service.ts` legacy publish function vs `atomic-publish` | Revision state and clients may still depend on both | Never assume dead code; trace routes/callers and rollback |
| `src/lib/ai/tasks/current-platform.ts` Task Type composition | Removing registered V1 may break historical Task processing/replay | Keep V1 parsers and old task handling; gates affect NEW release only |
| Coverage V1/V2 target policies / Task schema compatibility | In-flight/historical Tasks and legacy `selectedContactId` | Preserve old read/processing until data-driven retirement |
| `src/lib/services/service-catalog/agent-task.ts` Promotion V1/V2 | Deferred Promotion needs existing versions; historical rows may exist | Keep registered, do NOT activate or remove |
| `src/app/api/agent-tasks/cutover` and SQL test pilot RPCs | Operational rollback and TEST acceptance | Keep until post-acceptance replacement proven |
| `src/lib/whatsapp/transport/router.ts` Meta default and OpenWA adapters | Loss of incoming WhatsApp, ACK or provider parity | Strict KEEP; no duplicate outbound system |
| `src/lib/ai/tasks/trigger-worker.ts` and SQL 193 reaper | Crash recovery, idempotency and unprocessed queue | Strict KEEP; never remove with incomplete triggers |
| `supabase/migrations/*` | Migration replay and existing tenant data | IMMUTABLE, no deletion/editing of applied migrations |
| Shared Agent/Message/Inbox routes, RLS, reconciliation, accounting/coverage data | Business continuity and tenant isolation | Strict KEEP unless separate formal migration/proof |

**P22-00** record caller/reference graph, routes, usage and backward-compatibility tests. **P22-01** mark actual dead seams after measured stability and zero references. **P22-02** make small additive/compat changes with rollback, never bulk deletion. **P22-03** verify clean CI/SQL, manual regression, rollout watch and independent cleanup signoff. Any behavior risk → NO-GO.

## 6. Dependencies / release decision

```text
SCH-5 CI + TEST SQL (verified) ----> SCH-6 live/operator cases (OPEN)
Coverage two-target historic PASS --> AC-01..13 negative/recovery signoffs (OPEN)
                                       |
                                       v
                           Phase 21 internal coverage-only rollout
                                       |
                                       v
                         owner → selected → admins → limited GA
                                       |
                                       v
                        Phase 22 limited safe cleanup after stability
```

Promotion Phase 12/20 remains **deferred, separate**, and its absence must block any claim that the **entire V1 program or all Task Types** are generally available. Phase 21 can scope an internal/owner **Coverage-only** rollout after relevant acceptance, not all-agent GA.

## 7. Gate evidence and no-surprise operations

- **No Worker/Cutover/Pilot toggles by CI, docs or this plan.** Windows TEST local ownership and VPS ownership require independent runtime verification before any scheduled or multi-target test.
- Confirm no unsettled sends or acknowledgements with existing review hub before restart or rollback; never blind resend.
- User authorizes actual live bounded TEST sending and selects authorized recipients/cohort separately. No authorized send is implied by "complete phases."
- NOTE-001 current Supabase Auth leaked-password protection remains a Production security gate. OW14-W06 offsite backup/isolated restore is deferred; W07 and W08/09 Production GO not closed. No Production changes without direct authorization.
- Technical acceptance level is not equivalent to TEST operational, live, or Production. Do not close SOF-18, SOF-23, SOF-24 or SOF-66 without required evidence.

## 8. Recommended next implementation order

1. Execute all available **read-only/no-send** SCH-6 and Coverage acceptance preflights; attach evidence and list any actual blockers. Preserve paused triggers.
2. Run separately authorized bounded operator-controlled TEST scenarios, preferably leveraging one planned test cohort while distinguishing Coverage and Scheduler evidence, without unnecessary resends.
3. Close SOF-18, SOF-23, SOF-24, SOF-66 **individually** only after recorded PASS on their respective DoD.
4. Implement P21-01 durable gate + P21-02 UX and validate with exact-code CI, TEST migrations and manual accessibility. Advance internal only with signoff.
5. Continue P21 staged release after metrics, then P22 safe actual cleanup; defer full GA if Promotion remains unverified.
