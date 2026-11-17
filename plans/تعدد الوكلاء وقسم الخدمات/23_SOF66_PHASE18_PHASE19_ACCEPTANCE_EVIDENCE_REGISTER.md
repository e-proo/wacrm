# WACRM — SOF-66 / Phases 18–19: TEST acceptance evidence register

**Date:** 2026-11-17. **Status:** PRE-SIGNOFF / **NOT live acceptance complete**.  
**Baseline checked:** `e-proo/wacrm`, `refactor/service-platform-v2`, code HEAD `779c7910677049dd5a62394440861a1e9051c513` ([successful CI 44005517505](https://github.com/e-proo/wacrm/actions/runs/44005517505)); relevant migration clean replay [44000513145](https://github.com/e-proo/wacrm/actions/runs/44000513145). Documentation commits follow that baseline and must have their own CI status evaluated separately.  
**Source protocol (unaltered uploaded artifact):** [20_SOF66_PHASE18_PHASE19_TEST_ACCEPTANCE_PACK.md](20_SOF66_PHASE18_PHASE19_TEST_ACCEPTANCE_PACK.md).  
**Historical bounded happy-path checkpoint:** [19_SOF66_TWO_TARGET_LIVE_TEST_CHECKPOINT.md](19_SOF66_TWO_TARGET_LIVE_TEST_CHECKPOINT.md).  
**Linear:** [SOF-66](https://linear.app/eproo/issue/SOF-66), [SOF-23](https://linear.app/eproo/issue/SOF-23), [SOF-24](https://linear.app/eproo/issue/SOF-24).

## 1. What is actually evidenced

- On TEST, Task `14fcc0ca-a18b-4999-9f7e-4b85326796f0` (`coverage.sourcing@2`) processed **2** selected, tenant-owned CRM contacts on one pinned OpenWA connection: **2** distinct first-message reservations, both `sent` with provider IDs and one attempt each; two correctly correlated inbound runs.
- Both supplier targets and the Task reached `completed`. CHG-31 and CHG-32 were executed, producing separate 300 SAR offers and `coverage.offer.approved` business events. Requested coverage 550 SAR remained `active`, with 0 reserved and 0 fulfilled — **supplier capacity is not settlement**.
- The historic happy path was independently read-only inspected, with passing application CI and migration clean replay. A separate one-target rollback acceptance is documented in [14_SOF63_ONE_TARGET_LIVE_TEST.md](14_SOF63_ONE_TARGET_LIVE_TEST.md). None of these prove that every new AC-01..13 was executed.

## 2. Mapping historical proof to the new AC pack

`NOT RECORDED` means no timestamped PASS/FAIL and Task-scoped evidence for that **particular AC case** was provided in the uploaded acceptance pack. It does **not** mean the feature necessarily fails.

| Case | Historical corroboration | Uploaded AC result | Evidence still needed |
|---|---|---|---|
| AC-01 — create frozen bounded batch with worker stopped | Two-target historic Task exists | NOT RECORDED | New Task ID, worker off, exact 2–3 approved recipients and zero sends before start |
| AC-02 — pause before first send | Operator controls implemented/CI tests | NOT RECORDED | pause timestamp, two worker ticks and no sends/attempt consumption |
| AC-03 — resume, one first message/contact | Two distinct historic first sends verified | NOT RECORDED | new paused-task resumption and per-recipient reservation/provider IDs |
| AC-04 — worker restart | Prior one-target/recovery tests | NOT RECORDED | IDs stable across TEST Next restart and no duplicate send |
| AC-05 — two independent inbound replies | **Verified historically** on two-target Task | NOT RECORDED as a new AC run | Exact new task/conversation/target correlations or approved reuse signed as equivalent |
| AC-06 — explicit supplier decline | Negative automated regression exists | NOT RECORDED live | Real decline, target terminal and absence of offer |
| AC-07 — changed route review-only | Route contract/CI tests exist | NOT RECORDED live | review-only Change Request and zero matching offer |
| AC-08 — effective human takeover | Inbox/Task controls require joint proof | NOT RECORDED live | Inbox assigned staff **and** target disabled from AI continuation |
| AC-09 — opt-out | Suppression/admission checks in code/tests | NOT RECORDED live | opt-out receipt, prevention of any subsequent send |
| AC-10 — replay / idempotency | Distinct historic reservations; CI replay guardrails | NOT RECORDED per AC | CI run/test mapping and optional safe authorized replay without provider resend |
| AC-11 — honest negative completion | Historic positive Task auto-completion only | NOT RECORDED live | partial/failed terminal reason for no-offer Task |
| AC-12 — bounded rollback | Earlier one-target rollback reference | NOT RECORDED for new batch | `pilot → disabled`, worker stopped, zero unsettled operations |
| AC-13 — inbound after rollback | Historical one-target evidence possible | NOT RECORDED for new batch | ordinary CRM inbound after current rollback, no new Task send |

## 3. Rules for attestation

Each AC can be marked `PASS` **only** after evidence with UTC timestamp, observed code HEAD, TEST account, signed exact consent/cohort, Task/Target/Run/Reservation IDs, guardrail state and observed result is linked here or into the original pack. `FAIL` needs defect link + retest; `BLOCKED` needs cause. Mark `N/A` only with explicit DoD justification and an accepted automated equivalent — never silently.

- **SOF-66** requires multi-target safety, independently idempotent first sends, pause/recovery, opt-out, replay policy, rollback and account/consent negatives.
- **SOF-23** requires bounded cutover and real rollback/readiness, worker restart, crash/ambiguous reconciliation safety, post-rollback inbound.
- **SOF-24** requires effective decline, changed-route review-only, human takeover and honest no-offer completion, *in addition to* the already-proven positive two-supplier flow.

Record sign-off fields here once actually observed:

| Gate | Decision today | Signed evidence / reviewer |
|---|---|---|
| SOF-66 | OPEN — historical happy path verified, final AC gate unresolved | Pending |
| SOF-23 / Phase 18 | OPEN — one-target checkpoint exists, bounded final rollback/recovery unresolved | Pending |
| SOF-24 / Phase 19 | OPEN — positive supplier flow exists, negative/handoff AC unresolved | Pending |
| Production readiness | NOT CLAIMED — independent security/release gates, including NOTE-001 | Pending |

**No additional WhatsApp send, task/pilot toggle, migration deployment or Production change occurred as part of this documentation.** This register may be updated only from actual, scope-correct TEST/CI artifacts.
