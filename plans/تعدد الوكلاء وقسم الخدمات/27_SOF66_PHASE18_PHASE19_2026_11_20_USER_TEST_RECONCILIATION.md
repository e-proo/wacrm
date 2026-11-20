# SOF-66 + Phase 18/19 — 20 Nov 2026 user test notes and TEST evidence reconciliation

**Status:** Additional real TEST evidence corroborated; **NOT** a signed AC-01..13 full PASS or Production acceptance.
**Source:** Operator-uploaded `WACRM_SOF66_PHASE18_PHASE19_TEST_ACCEPTANCE_PACK(2).md` (SHA-256: `6dcf2a1051fb3095063cf8f01e42bb3c0f9a558eb83ee0ba4cd0bcfafca222e2`). The uploaded pack still carries **17 Nov 2026** as its original drafting date and old HEAD `779c7910677049dd5a62394440861a1e9051c513`. Operator annotations “جاهز” appear at AC-01/02/03/04/05/07/08 and “جاهز لم يوفر العميل التغطية ... المهمة كمهمه مكتمله جزئيا” at AC-11. The per-case results/evidence template at the end is **not filled in**. “جاهز” means operator-reported readiness, not an authenticated PASS record.
**Recheck:** GitHub `e-proo/wacrm` / `refactor/service-platform-v2` HEAD `98d167cde0895a87462e893c1664454aefcf8949`, [application CI 44784835449](https://github.com/e-proo/wacrm/actions/runs/44784835449) `completed/success`. Actual Supabase `wacrm test` project `pqirsnfupofhulmewakq` checked via strictly **read-only** SQL on 20 Nov. The prior verified positive two-target Task `14fcc0ca-a18b-4999-9f7e-4b85326796f0` remains historic evidence and should not be resent.

## 1. New TEST evidence beyond the original 17 Nov pack

### Task A — two-target 17 Nov 2026 controlled run

Task `bb649931-a6a3-4e2f-a9a8-5490bbb83a1e`, `coverage.sourcing@2`, created **20:41:37 UTC**, completed **21:01:25 UTC** with no manual closure. Exactly two Targets and two distinct first-send Reservations, idempotency keys and provider IDs; both `sent`; no Task-scoped `sending` or `requires_reconciliation` at read time; maximum one attempt per target.

- `task.paused` at **20:42:27 UTC** → `task.resumed` at **20:45:03 UTC** → first reservation **20:45:52 UTC** and send **20:46:14 UTC** → second reservation **20:46:23 UTC** and send **20:46:46 UTC**. Thus no *first-message* send was recorded before resume. **Not proof of two full 15-second worker ticks during pause** or an actual Next.js process restart.
- Two successful **inbound** Agent Runs tied to two distinct Targets. **One other inbound Run failed** with safe code `SUPPLIER_WORKFLOW_FAILED`; diagnose before acceptance, despite subsequent successful Runs.
- Exactly one `coverage.supplier_counteroffer.review` Change Request executed for Target B; **0 Coverage Offers** linked to this alternative review. Separately an executed `coverage.offer.create` Change Request from Target A yielded **1** Offer. This substantiates a review-only alternate route rather than inadvertently creating an automatically matching Offer.
- Target B `paused_for_human`; its Inbox conversation has `ai_autoreply_disabled=true` and a non-null staff assignment. No additional Task first send was found after its most recent target state transition. This is bounded evidence, **not** proof that every possible conversational channel/agent action was disabled.
- The upload does not provide a signed operator event for original worker-off-at-creation, exact cohort/consent, actual process restart or manual confirmation.

### Task B — 20 Nov 2026 partial completion without fabricated offer

Task `83e0f33b-7554-4f39-b2e4-66ac8bceb9b2`, `coverage.sourcing@2`, created **17:37:42 UTC**, automatically ended **17:43:29 UTC** as `partially_completed`, `manual_closure_kind=NULL`. One selected Target, one first-message Reservation `sent` with provider ID, no unsettled Task send.

- `target.paused_for_human` at **17:41:07 UTC**; `task.partially_completed` at **17:43:29 UTC**. **Zero** Change Requests via Task-linked Agent Runs, therefore **zero** Coverage Offers from such Change Requests. This supports the user note “no coverage provided, no fictional availability or offer, partial task completion.”
- Qualification: Task B's linked Inbox record does **not** currently show staff assignment or disabled auto-reply, and no inbound Agent Run was recorded. A paused-for-human Target is **not the same as an explicit documented supplier refusal** or a completed Inbox takeover. Review why the Task was terminalized partially with this unresolved handoff state.

### Latest TEST cutover — read-only observation

`inspect_ai_agent_task_test_cutover_readiness(account)` returned `mode=pilot`, `ready=true`, `blockers=[]`, `nonterminal_tasks=0`, `sending_messages=0`, `reconciliation_messages=0`, `nonterminal_trigger_firings=0`, `open_whatsapp_circuits=0`, `outbound_task_delivery_enabled=true`, `whatsapp_scope.enabled=true`.

Thus **AC-12 was NOT yet evidenced as completed** for the latest batch: the CUTOVER is still in Pilot. **AC-13 inbound after this rollback is not evidenced.** Neither TEST cutover nor the worker/Pilot was modified during verification.

## 2. Case mapping (uploaded notes versus actual TEST evidence)

**CORROBORATED** = relevant technical evidence exists, but the complete UTC operator sign-off and any unobserved subcondition remain open; do NOT silently mark full PASS.

| AC | User marker | Verified condition / remaining gap | Status |
| --- | --- | --- | --- |
| **01** Bounded task with worker stopped | جاهز | Task A has exactly 2 Targets and messages after resume, but no worker-off-at-create or signed cohort snapshot | **Partial corroboration** |
| **02** Pause before send | جاهز | Paused before resume and both initial sends; no two-worker-ticks observation | **Corroborated, sign-off missing** |
| **03** Resume and one send/Target | جاهز | 2 distinct idempotency keys + provider IDs + no unsettled sends | **Corroborated, sign-off missing** |
| **04** Worker restart | جاهز | No actual process restart timing or same-ID cross-restart proof | **Reported ready, not verified** |
| **05** Inbound correlation | جاهز | 2 successful inbound Runs → 2 distinct Targets; **one failed** inbound Run `SUPPLIER_WORKFLOW_FAILED` | **Corroborated; defect review open** |
| **06** Supplier explicitly declines | no marker | No dated affirmative refusal with terminal reason verified | **Open** |
| **07** Alternative route is review-only | جاهز | One executed `coverage.supplier_counteroffer.review` yielded 0 matching Offers; a separate Target's `coverage.offer.create` yielded one | **Corroborated; route review sign-off pending** |
| **08** Human handoff | جاهز | Task A Target B human-paused + Inbox auto-reply disabled + staff assignment, no further initial Task send observed | **Corroborated; human sign-off pending** |
| **09** STOP / opt-out | no marker | No dated opt-out and subsequent suppressed-send evidence | **Open** |
| **10** Replay/idempotency | no marker | Historical CI/SQL guardrails + unique first-send keys; no recent independently authorized webhook replay evidence | **Automated-only; exact CI mapping needed** |
| **11** No fake offer / honest terminal | جاهز، لم يوفر التغطية، مكتملة جزئيًا | Task B `partially_completed` without manual closure or Task-originated Offer; human-paused without Inbox takeover or inbound refusal proof | **Partial corroboration; clarify handoff** |
| **12** Rollback | no marker | Current CUTOVER `pilot` and outbound enabled, not `disabled` | **Open** |
| **13** Inbound after rollback | no marker | No new independent post-rollback inbound proof | **Open** |

There is **no** evidence in this upload that covers **SOF-18 / SCH-6** scheduling acceptance. The original historical positive 2-target Task and documented one-target rollback remain valid partial evidence, not a substitute for the named missing cases.

## 3. Immediate next step, with minimal new provider sends

1. **No-send preflight:** Review the safe cause and resolution of Task A's `SUPPLIER_WORKFLOW_FAILED`. Examine Task B's `paused_for_human` versus its missing Inbox assignment/disabled auto-reply; distinguish normal partial/no-offer conclusion from actual human takeover. Attach operator UTC time/HEAD and screenshots for AC-02/03/07/08/11; if AC-04 process restart was actually done, provide Windows start/stop + Task ID evidence. Map AC-10 to an exact CI replay test rather than forcing an ambiguous provider replay.
2. **Only for gaps that really require new authorized TEST messages:** Run bounded explicit **AC-06 decline** and **AC-09 opt-out** with approved test numbers and consent, using a controlled single-worker test. Do not resubmit historical or unknown provider requests. Keep Promotion deferred.
3. **AC-12 → AC-13 at the end of the TEST batch:** After all attempts are settled and the actual Windows/VPS worker owner is verified, an authorized operator explicitly switches account Task cutover to `disabled` and stops its worker; confirm sending/unknown=0, outbound and WhatsApp scope disabled. Then **one ordinary inbound-only TEST message** from an authorized contact proves CRM intake and zero new Task send. Never turn the Pilot off automatically just to produce a report.
4. **Separate SCH-6 acceptance:** Execute SCH-AC-01..11 for one-time, recurring, business-event, recovery, skip/backlog, tenancy and rollback with the *existing scheduler*; record actual case results. It is not complete based on this Coverage upload.
5. Only after independent signed acceptance, close SOF-66/SOF-23/SOF-24, then advance Phase21 **coverage-only** internal Builder release. Phase22 still begins with inventory and compatibility tests, not destructive deletion. Service Promotion SOF-17/SOF-25 remains deferred.

## 4. Gate decisions

- **SOF-66 — In Progress:** Positive and resumed two-target sends corroborated; final restart/opt-out/replay/rollback/inbound-after-rollback signoff pending.
- **SOF-23 / Phase 18 — In Progress:** Pause/resume corroborated; actual restart and bounded rollback/post-rollback inbound unverified.
- **SOF-24 / Phase 19 — In Progress:** Review-only alternate, Inbox takeover and no-offer partial outcome corroborated, with explicit refusal and inbound failure investigation remaining.
- **SOF-18 / SCH-6 — In Progress:** Not addressed by this upload.
- **SOF-26 / Phase21 — preparation only:** No cohort activated.
- **Production ready — NO:** NOTE-001 and other independent release/DR gates apply.

**No live sends, TEST writes, worker/Pilot toggles, migrations, VPS or Production changes were made to gather or document this evidence.**
