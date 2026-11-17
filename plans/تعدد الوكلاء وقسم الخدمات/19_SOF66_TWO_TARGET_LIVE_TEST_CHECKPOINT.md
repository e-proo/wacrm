# SOF-66 / Phase 18–19 — Bounded two-target Coverage TEST checkpoint

**Evidence date:** 2026-11-17. **Verification:** Read-only hosted TEST SQL, GitHub source/CI and Linear acceptance contracts. **Scope:** real multi-target happy path verified, **NOT** final rollback/handoff/cross-provider live acceptance or Production readiness.

## Source of truth

- WACRM branch: `refactor/service-platform-v2`; inspected HEAD [`080758283c3fca72f4ce9dcb5db75a80a02f2fce`](https://github.com/e-proo/wacrm/commit/080758283c3fca72f4ce9dcb5db75a80a02f2fce).
- [CI 44001153114](https://github.com/e-proo/wacrm/actions/runs/44001153114): **completed/success on this exact SHA**, Lint, Typecheck, 2259 passed tests / 20 skipped, Build.
- [Migrations 44000513145](https://github.com/e-proo/wacrm/actions/runs/44000513145): **completed/success** on schema-bearing `faf9f46ca1b2a4b871ce9878e6895d1128d0fd92`; clean migration replay and Agent Task selection, transport binding, guardrails, observability, security, integration, crash recovery, two-account RLS, Coverage smoke. Latest additive OpenWA LID/retention migrations found applied in TEST. No applied migration was modified.
- TEST account `8ed95309-96cd-4347-b725-bd8c5039ed4f`; Task `14fcc0ca-a18b-4999-9f7e-4b85326796f0` (`coverage.sourcing@2`), source Coverage Request `6008bfa5-1fd6-49bb-9451-9549a064f460`, OpenWA connection `67ca97ea-60c8-448d-98dc-72a50f6a87dc` (`ready`, non-archived).
- All SQL evidence captured without writing data, approving another offer, triggering a worker, changing Pilot settings or sending any WhatsApp.

## Actual happy-path result

- Task created **02:26:04 UTC**, started **02:26:05 UTC**, completed **02:34:04 UTC** with `manual_closure_kind=NULL` and one `task.completed` event `reason=supplier_offer_executed`, `totalSuppliers=2`, `completedSuppliers=2`.
- Exact frozen target policy contains **two unique, ordered CRM contact IDs** and one pinned OpenWA connection. Target A `d1346ee7-a803-4159-8b3a-9c573bad2bba`, Target B `7ea926f1-7977-463d-bca3-e727c5b18716`; each status `completed`, each `attempt_count=1`, each has a different conversation. No raw phone numbers are recorded in this acceptance document.
- Target A CRM contact was created shortly before the Task on TEST and had **zero historical Coverage supplier offers** at launch. This confirms the explicitly selected contact without matching history was permitted as *advisory eligibility*; target B had historical offers. Both remained subject to consent, tenant, suppression and Pilot controls.
- Exactly **two distinct `ai_agent_task_outbound_messages` rows**, both `provider=openwa`, `status=sent`, same frozen connection; one reservation and one idempotency key per target. Each has a non-empty provider message ID and a distinct local message ID. **Zero** Task-scoped `reserved/sending/requires_reconciliation` rows at inspection.
- Exactly two successful outbound Runs and two successful inbound Runs; every inbound Run's message conversation and CRM contact match its exact Target. No cross-target reply evidence.
- Both supplier negotiations were `submitted`, `route_confirmed=true`, `route_different=false`, with `offered_amount=300` SAR and `commission_per_thousand=7` per supplier. **CHG-31** and **CHG-32** independently `executed` under `coverage.offer.create`; each produced one *different* active Coverage Offer for **300 SAR**, commission **2.10 SAR**, matching reverse settlement route. Each Change Request emitted exactly one `coverage.offer.approved` Business Event `sent` and one linked business outcome.
- This is **supplier offer capacity**, not a financial reservation. The original request remains `active`, requested **550 SAR**, reserved **0**, fulfilled **0**. The sum of two independent possible offers is **600 SAR**; WACRM must never present that as 600 SAR already reserved/settled or auto-allocate above the remaining 550 SAR. Supplier sourcing is completed separately from settlement.
- Current TEST cutover snapshot `mode=pilot`, `ready=true`, no nonterminal Tasks, sending messages, reconciliation messages or open WhatsApp circuits. The specific session had two active, expiring `workload=agent` telephone-consent pilot grants (plus separate API workload grants). Admission events for `agent` during the test show allowed/approved. **This is not proof of post-pilot rollback.**

## Gate assessment — precise completion levels

| Gate | Status | Reason |
| --- | --- | --- |
| Generic exact multi-contact Task, target identity, OpenWA send and per-contact reply correlation | **live TEST happy path verified** | One Task with 2 completed targets and 2 independently executed Coverage Offers, no duplicated first reservation |
| SOF-64 per-Task WhatsApp connection picker | **implementation + automated CI/TEST + live create verified** | Frozen account-scoped `whatsappConnectionId` selected and honored; negative edit/tenant/session guards in API and migration CI |
| SOF-65 selected CRM target filter (legacy single) | **implementation + automated CI/TEST + live create verified** | Historical single target SOF-63/Phase11 plus selected two-target upgrade; tenant and pending edit checks in CI |
| SOF-61 agent send workload and transport reconciliation | **implementation + CI/TEST + bounded live authorized workload verified** | `workload=agent` hashed consent grants, admission, distinct reservations; crash/recovery and ambiguous-state fail-closed CI |
| SOF-62 Meta/OpenWA routing and regression matrix | **automated CI/clean-migration smoke verified; OpenWA live** | Meta approval/template and all negative routing gates in CI; live OpenWA pinned delivery; separate Meta live not claimed |
| Phase 14–17 reliability/observability/security/test matrix | **implementation + CI + TEST clean replay verified** | Prior hosted TEST smoke + current CI + clean local migration smoke including multi-account RLS; NOTE-001 remains project-wide |
| SOF-66 **full** multi-recipient DoD | **NOT closed** | No recorded **post-batch rollback**, live pause/resume, intentional crash/restart recovery, webhook replay/ambiguous-provider scenario, opt-out/handoff acceptance; current cutover is still `pilot` |
| Phase 18 / SOF-23 | **NOT closed** | Bounded batch and one-target rollback demonstrated separately, but comprehensive same-gate live pause/resume, crash/recovery and batch rollback missing |
| Phase 19 / SOF-24 | **NOT closed** | Two-supplier matching-offer happy path verified; live **different-route counteroffer**, decline/opt-out and **human takeover/handoff** still require bounded acceptance |

## Safe remaining acceptance (operator-authorized, TEST only)

1. Inspect and reconcile any unsettled sends (currently zero) before toggling controls.
2. Under bounded test authorization exercise **pause → no new Task sends → resume**, and **worker restart → no duplicated Run/Reservation/WhatsApp send**.
3. Exercise a supplier **different-route** alternative and **human takeover / explicit decline**. Record that a different-route proposal goes to review-only and **never** manufactures a matching Coverage Offer.
4. Exercise a bounded replay of webhook/Run claim and, if there is a genuine ambiguous timeout, reconcile against provider evidence rather than blind resend. Do not manufacture a WhatsApp send or duplicate.
5. Perform guarded **`pilot → disabled` rollback**, verify flags and zero unsettled rows, verify an ordinary inbound still reaches CRM **after** rollback. Keep independent session Pilot controls consistent with the operator's intended TEST state.
6. Attach new evidence to SOF-66, SOF-23, SOF-24, then close each only after its own DoD. Do not perform any Production actions. `PROJECT_NOTES.md` **NOTE-001** remains open and precludes Production/GA readiness.

## Related source

- [SOF-66 plan](17_SOF66_MULTI_RECIPIENT_AGENT_TASKS.md), [Phase 11 signoff](18_SOF16_COVERAGE_SOURCING_ACCEPTANCE.md), [SOF-63 one-target rollback](14_SOF63_ONE_TARGET_LIVE_TEST.md).
- [Agent Task main plan](10_AI_AGENT_TASK_AND_OUTREACH_PLATFORM_V1.md), Linear [SOF-66](https://linear.app/eproo/issue/SOF-66/sof-66-akhtyar-adh-arqam-mhddh-dakhl-mhmh-wkyl-wahdh), [SOF-23](https://linear.app/eproo/issue/SOF-23/phase-18-first-teststaging-cutover), [SOF-24](https://linear.app/eproo/issue/SOF-24/phase-19-coverage-sourcing-pilot).
