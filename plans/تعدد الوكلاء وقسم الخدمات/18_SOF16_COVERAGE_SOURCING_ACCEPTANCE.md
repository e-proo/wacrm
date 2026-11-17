# SOF-16 — Phase 11 Coverage Sourcing Agent: acceptance record

**Decision:** Phase 11 **implementation complete + CI/TEST verified + one-supplier live TEST acceptance complete** as of **2026-11-17**. This does **not** close the broader Phase 18 cutover, Phase 19 bounded 2–3-supplier pilot, SOF-66 multi-recipient testing, or production readiness.

## Provenance and scope

- GitHub source of truth: `e-proo/wacrm`, branch `refactor/service-platform-v2`.
- Acceptance test code SHA: [`9bb1cb3d9c9ce195a1a0605039a1f42c4834bdd3`](https://github.com/e-proo/wacrm/commit/9bb1cb3d9c9ce195a1a0605039a1f42c4834bdd3).
- Exact-sha application CI: [run 43994864334](https://github.com/e-proo/wacrm/actions/runs/43994864334), **completed/success**: lint, typecheck, test (**250 passed test files / 2222 passed tests, 15 files and 20 tests skipped**), Build and OW-4/Meta regression gate.
- Latest relevant clean migration replay: [Migrations run 43984355354](https://github.com/e-proo/wacrm/actions/runs/43984355354), **completed/success** on migration-containing SHA `2a43933b83971b9ec415ab05581931c9b058eca8`, including additive `178_coverage_supplier_counteroffer_route.sql`. Subsequent changes for this acceptance are TypeScript/tests/docs, not schema rewrites.
- TEST Supabase project: `pqirsnfupofhulmewakq`; all acceptance checks below are **read-only** against existing evidence. No new WhatsApp sends, approvals, business mutations, migration deployment or Production changes were performed for this signoff.
- Representative bounded live business case: account `8ed95309-96cd-4347-b725-bd8c5039ed4f`, source Coverage Request `6008bfa5-1fd6-49bb-9451-9549a064f460`, `coverage.sourcing@2` Task `42492efd-c294-4c21-82e4-e2850f8064f0`, Target `c469d2b4-157d-4510-b711-784802385090` (the TEST supplier), Change Request **CHG-30** `6a3f1c46-cb46-4c17-a504-55a2c8d0e207`, Coverage Offer `30cd7255-143f-4888-adb5-f3fe9ea78587`.

## Authoritative TEST E2E evidence

The single-task, single-supplier joined SQL acceptance query was re-run on **2026-11-17** with exact account/task/Change Request predicates. Results:

| Plan Phase 11 contract | Evidence | Result |
| --- | --- | --- |
| Frozen source Coverage Request / deterministic target | Task `coverage.sourcing@2` with frozen request and route; one `target.selected` event and one exact Target | PASS |
| WhatsApp outbound | One `ai_agent_task_outbound_messages` reservation, `provider=openwa`, `status=sent` (not a claim of verified read receipt) | PASS |
| Inbound supplier reply correlation | Six successful Task-linked Runs: one outbound and five inbound, all on the same Task Target and conversation; `target.replied` events present | PASS |
| Durable proposal / admin approval | Exactly one Task-linked Change Request, **CHG-30**, `action_key=coverage.offer.create`, `status=executed`; approval 2026-11-17 00:52:00Z, execution 00:52:03Z | PASS |
| Real Coverage Domain outcome | Exactly one active `coverage_offers` row associated with CHG-30: **550 SAR**, commission **7 per 1000** (commission **3.85 SAR**) | PASS |
| Canonical Business Event | Exactly one correlated `coverage.offer.approved` in `business_event_outbox`, `status=sent` at 00:52:22Z; exactly one `ai_agent_business_outcome_links` trace link | PASS |
| Completion | Target `completed` at 00:52:02Z; Task `completed` at 00:54:21Z; exactly one `task.completed` event, `reason=supplier_offer_executed` | PASS |
| No accidental duplicated initial outreach or offer | Exactly one initial outbound reservation, one executed Change Request, one resulting Coverage Offer and one correlated Business Event for this Task | PASS |
| Separate sourcing from financial execution | Original Request remains `active`, `requested_amount=550`, `reserved_amount=0`, `fulfilled_amount=0`; source Request was **not** mislabeled fulfilled | PASS |

The parent Task previously waited for the orchestrator's 300-second backoff; commit `60fba6af28525816b96ec87a92c005d6c219c2e6` added an account-scoped, best-effort post-commit completion evaluation. Its new **immediate** timing remains a separate future live regression case; it does not invalidate the already-observed completed Task.

## Automated negative/safety acceptance

- `src/lib/services/coverage/agent-task.test.ts`: domain Task registration, supplier source/eligibility, exact selected-contact constraints, frozen route matching, Meta-v1 template preservation, OpenWA-v2 deterministic outbound, non-leaking outreach.
- `src/lib/services/coverage/supplier-task-dialogue.test.ts` and `supplier-quote-extraction.test.ts`: natural-language full quote, missing fields, explicit decline, different route and commission parsing.
- `src/lib/services/coverage/supplier-task-workflow.test.ts`: authenticated account/task/target/conversation/run reply binding; one-turn proposal; route mismatch **review-only** (not a matching offer); proposal-grant loss → human follow-up; crash recovery and duplicate replay fail closed.
- `src/lib/services/coverage/change-executors-counteroffer.test.ts`: incorrect route cannot silently produce a matching Coverage Offer.
- NEW `src/lib/services/coverage/agent-task-completion.test.ts`: exact source account/Task scope; approved supplier target completes sourcing while underlying Request stays active; other actionable suppliers prevent premature completion; exhausted/refused/human-handled target alone cannot create an approved outcome; empty candidate set, request fulfilment, cancellation/expiry, and missing source Request cases.
- `src/lib/ai/tasks/approved-coverage-completion.test.ts`: only a properly bound, executed approved offer triggers immediate policy evaluation, and still respects other open supplier targets.
- CI/Migrations: `supabase/ci/coverage-sourcing-agent-smoke.sql`, `agent-task-supplier-negotiation-smoke.sql`, `agent-task-transport-binding-smoke.sql`, `agent-task-security-acceptance-smoke.sql`, `agent-task-crash-recovery-smoke.sql`, `agent-task-rls-smoke.sql`, and related clean replay.
- `src/lib/ai/runtime/dispatch.ts`: supplier refusal outcome uses the registered `record_agent_task_target_outcome` and registered Task completion policy. Failure to persist an outcome pauses for human rather than pretending success.

## Scope distinction / deferred gates

The **Phase 11** use case is accepted because one genuine Coverage request→supplier outreach→authenticated reply→native proposal→human approval→Coverage Offer→Business Event→Task completion has completed on TEST, with automated rejection/security branches. This is not evidence that all negative supplier scenarios were individually exercised over live WhatsApp.

The **Phase 19** requirement of **2–3 different consented TEST suppliers**, independent counteroffers/declines, no cross-target reply, human handoff, and bounded pilot controls remains open under [SOF-24](https://linear.app/eproo/issue/SOF-24/phase-19-coverage-sourcing-pilot) and [SOF-66](https://linear.app/eproo/issue/SOF-66/sof-66-akhtyar-adh-arqam-mhddh-dakhl-mhmh-wkyl-wahdh). Phase 18 TEST cutover is also separately open; no automatic Pilot activation, mass sends or production rollout is authorized by this closure.

The historical Meta `API access blocked` from the old SOF-16 comment is **resolved** in `PROJECT_NOTES.md` NOTE-002. Provider compatibility does not require replacing Meta with OpenWA. `PROJECT_NOTES.md` NOTE-001 (Supabase project-wide security debt) remains **open** and must be re-evaluated before any Production/GA decision.

**Conclusion:** Close **SOF-16 (Phase 11)** as the domain use-case acceptance gate, but **keep SOF-24, SOF-66, SOF-23 and Production readiness separate/open**.
