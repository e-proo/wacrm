# Agent Task: Scheduler + Coverage pre-acceptance, Phase 21/22 entry record

**Checked:** 2026-11-20 · **GitHub:** e-proo/wacrm @ `refactor/service-platform-v2` · **starting HEAD:** `165123addb8e2b149de2ce66e1f97c22522ec9c4`.

## Evidence actually checked

- Application CI at starting HEAD: [44773738872](https://github.com/e-proo/wacrm/actions/runs/44773738872), **completed/success**; prior clean Migrations with local concurrency and RLS: [44771991558](https://github.com/e-proo/wacrm/actions/runs/44771991558), **completed/success** on its own SHA. Do not confuse application CI with TEST human acceptance.
- Supabase **wacrm test**, read-only migration listing and SQL, checked 2026-11-20: migration `agent_task_trigger_exhausted_lease_reaper` (code migration 193) present, version `20261117224716`. Check involved no DML/DDL or provider/worker calls.
- **TEST live snapshot as checked:** enabled triggers **0**, paused triggers **2**, pending/claimed firings **0**, queued/running/scheduled/validating Tasks **0**. Over last seven days: 13 newly created Agent Tasks, 4 of those completed. These are historical observational counts; no customer identifiers exposed. Paused triggers were left paused.
- SCH-1..5: implementation, local concurrency and SQL TEST evidence documented at `docs/development/agent-task-scheduling-sch5-technical-acceptance.md`; SCH-6 **not yet signed**.
- SOF-66 / SOF-23 / SOF-24: prior one-target OpenWA TEST (SOF-63) accepted, two-target happy path and two approved offers documented, but `23_SOF66_PHASE18_PHASE19_ACCEPTANCE_EVIDENCE_REGISTER.md` shows AC-01..13 **not signed as a consolidated PASS run**. Do not reuse historical happy path as false proof of pause/restart/decline/counteroffer/human takeover/rollback.
- Current Linear on this date: SOF-18, SOF-23, SOF-24, SOF-66 **In Progress**; SOF-26/SOF-27 **Backlog** before Phase21 kickoff; SOF-17/SOF-25 were **In Progress** before user decision to defer Promotion.

## Present decision

**Technical scheduler implementation:** verified, no new runtime scheduler required. **SCH-6 TEST operational acceptance:** OPEN.

**Multi-recipient Coverage & cutover technical implementation:** verified in prior CI/TEST snapshots and historical two-target positive flow. **Formal combined negative/recovery/live acceptance:** OPEN.

**Phase 21:** start at P21-00 code/contract/release design only; no internal cohort or actual rollout yet. Fail-closed pure policy contract is `src/lib/ai/tasks/builder-release-policy.ts`, not wired to any create/publish/send/worker endpoint; all current runtime permissions remain unchanged. Coverage-only `coverage.sourcing@2` is the proposed initial scope after signoff. A future enforceable release requires server-authoritative immutable stage approval, role/account gates and dedicated audits before routing into every relevant action.

**Phase 22:** inventory/design only; do not delete compatibility paths, legacy API, migrations, providers, webhook intake, reconciliation, task V1, coverage business records or Agent inbound. Any actual removal requires verified real usage/callers and rollback on the stage released in Phase21.

**Promotion (SOF-17/25):** deferred by user. Existing published revisions, historical tasks and registered service catalog code stay intact. Do not enable campaigns or triggers.

## Independent conditions before changing release stage

| Gate | Evidence available | Decision |
| --- | --- | --- |
| SCH-6 `SCH-AC-01..11` actual operator/TEST acceptance | Technical SCH-5 SQL/CI only | OPEN |
| SOF-66 multi-recipient negative/recovery | Historical two-target success; missing combined signed AC | OPEN |
| SOF-23 bounded cutover/rollback + inbound proof | Prior one-target only; new batch rollback missing | OPEN |
| SOF-24 decline, review-only alternative, human takeover, honest completion | Positive two-supplier flow recorded; negative LIVE acceptance missing | OPEN |
| Single actual scheduler/worker owner (Windows or VPS) | No authorized runtime measurement in this audit | OPEN |
| Meta/OpenWA last chance, policy and reconciliation | Code regressions available; still need bounded controlled TEST gate | OPEN for new release |
| Owner/admin role + account isolation | CI exists, rollout transition not implemented yet | OPEN |
| Supabase NOTE-001 auth leaked password protection, W06 DR, OW14 release | Known independent Production gates | NOT CLEARED |

## Safe execution sequence

1. Freeze source, session, approved recipients, consent, Task revision and limits on TEST, recording account and IDs **only in approved private evidence**; check there is one actual runner owner. Leave worker and cutoff unchanged until authorized.
2. Run no-send/negative cases and add proof to existing Coverage and Scheduler acceptance registers.
3. Run only separately authorized bounded live cases and rollback with exact idempotency. Never send new messages to manufacture a pass or auto-retry ambiguous provider timeouts.
4. Close SOF-18/SOF-66/SOF-23/SOF-24 individually only after their own DoD and signed PASS evidence.
5. Wire P21 gate into server-authoritative Builder + task-creation controls, ship first to internal/owner coverage-only cohorts, observe metrics then expand explicitly. Keep Promotion deferred and full GA withheld until its separate DoD.
6. Begin small P22 removal only after measured stability and reference graph/contract tests; preserve inbound/Meta/OpenWA and migration history.

**No actions undertaken by this read-only check:** sending, Cutover/Pilot toggles, worker start/stop, VPS/Production update, Supabase TEST schema/application mutation. Human acceptance and deployment cannot be inferred from GitHub code or SQL snapshot.
