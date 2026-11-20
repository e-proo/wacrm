# WACRM — Bounded LIVE TEST runbook: owner-controlled supplier + admin phone

**Prepared:** 2026-11-20
**Project:** Agent Task Platform / Coverage Sourcing + Scheduler
**GitHub source:** e-proo/wacrm branch `refactor/service-platform-v2` (verify fresh HEAD at execution)
**Links:** SOF-66, SOF-23 (Phase18), SOF-24 (Phase19), SOF-18 (SCH-6); initial coverage-only Builder P21 remains HOLD.
**State:** A/B supplied privately by operator; exact same-session CRM contact + native LID Pilot approvals and admin identity VERIFIED read-only. LIVE SEND NOT EXECUTED. Actual single worker ownership, authenticated UI action and fresh-time gate remain REQUIRED.

## Scope and exact ownership

**A = SUPPLIER_TEST_A**, a mobile number the operator personally owns, used to RECEIVE and ANSWER a supplier Coverage Sourcing Task. Must be explicit WhatsApp TEST-consented and be a current account-scoped contact (or newly created under current supported account-scoped selection), not the source Coverage Request's own contact. Use its international format **privately in WACRM UI only**, not in this public repo file.

**B = ADMIN_TEST_B**, a DIFFERENT mobile number personally owned by the operator, used to RECEIVE authorized admin review/notification messages and send an ordinary inbound CRM message after outbound rollback. Admin phone is a notification *recipient*, NOT automatically a second supplier and does NOT automatically grant it Owner/Admin application role. Never assume the phone is a valid supplier target or count it toward multi-supplier acceptance without the user's additional explicit role/consent decision.

Use only `coverage.sourcing@2`. **Service Promotion SOF-17/25 is deferred**, with all its automation and campaigns kept inactive. Meta remains official/default Production transport; OpenWA is optional TEST transport selected per actual connection. No blind resend, automatic cross-provider retry, bypass of Pilot, anti-abuse, cutover or account scope. Initial messages and any follow-ups require existing recipient permission and account/connection safeguards.

**Important:** One supplier + one admin number cannot by themselves establish a fresh **2–3 supplier target** test. The historical independently verified two-supplier TEST Task is reusable as previous *positive* evidence if acceptance owners approve equivalence; otherwise request an additional expressly authorized supplier contact. Do not mislabel admin notifications as a second supplier Target.

## Latest preflight observed (read-only snapshot; must recheck immediately before send)

As of 2026-11-20, authorized Supabase `wacrm test` was inspected via account-scoped, read-only queries:

- GitHub HEAD at the preflight: `33537d43e2fa2adb5871d2b58b8eebb840a401e6`, [CI 44790383706](https://github.com/e-proo/wacrm/actions/runs/44790383706) completed/success.
- Account-wide `inspect_ai_agent_task_test_cutover_readiness`: `mode=pilot`, `ready=true`, `blockers=[]`, `sending_messages=0`, `reconciliation_messages=0`, `nonterminal_tasks=0`, `nonterminal_trigger_firings=0`, `open_whatsapp_circuits=0`, `outbound_task_delivery_enabled=true`, `whatsapp_scope.enabled=true`. NOT evidence of immediate provider reachability or approved target cohort.
- Exactly **one unarchived OpenWA connection with status=ready**, short identifier prefix `67ca97ea`, existing Session ID, Pilot enabled and **5 active agent Pilot grants**. These existing grants DO NOT prove either NEW A or B is included. There is also another unarchived OpenWA session `logged_out` with Pilot enabled and **0 active agent grants**; never select that as ready. Official Meta connection has status `connected`, and is a separate provider with different admission.
- Existing coverage schedules: 2 paused, 1 completed, 0 enabled. Do not automatically unpause to start this test.
- A/B numbers were supplied in the private conversation; the exact TEST account/contact/native chat and grants were verified without storing raw numbers in this file. The provider selection is the unarchived READY OpenWA session. Actual single Windows/VPS worker ownership, operator UI access, safe source Coverage Request and bounded live scenario still require verification before sending.
- We can inspect GitHub/CI and hosted TEST SQL through available connected tools, but **this conversation cannot click the user's Windows-local WACRM UI or the Cloudflared tunnel, start a Windows worker, or read the target phones from an unspecified message**. SQL service_role writes that bypass authenticated WACRM API are forbidden as test orchestration.


## Trusted admin approval notifications (read-only TEST and code evidence)

The function in `src/lib/ai/runtime/business-notifications.ts` only notifies an ACTIVE, non-revoked WhatsApp `trusted_admin_identities` record with the `change_requests.approve` capability. An account phone setting alone is insufficient; a dashboard notification is a separate PIN-free fallback.

For an OpenWA supplier-originated proposal, the one-time admin approval notification uses the EXACT selected connection and the `api` workload, **not** the supplier `agent` workload. Admin recipient B must have its OWN unexpired `api` Pilot grant; supplier A needs its own `agent` grant. No cross-provider fallback or blind resend after ambiguous outcome. Never paste the approval PIN into ChatGPT, the repo, CRM message logs or a support screenshot; use the authorized UI only.

A 20 Nov TEST **read-only** query found **one eligible trusted admin approval identity**, **one live `api` grant on the ready OpenWA connection**, and **five live `agent` grants**. These numbers DO NOT establish that the newly supplied B/A phones match any grant or identity. Check the actual identity and consent in the private WACRM administrative UI before sending; no SQL identity/grant change should be made.

If a supplier simply declines with no Change Request, it is normal for no admin approval PIN notice to be generated. Test admin delivery only as the outcome of a separately approved, genuine review-required proposal; never manufacture a secret-bearing message to trigger a notification.


## 2026-11-20 follow-up after the operator supplied A/B phone numbers

The two personally controlled phone numbers were provided **privately in conversation**, and this public planning artifact intentionally contains only aliases A/B. Source-of-truth source code hash: `openWAPilotRecipientHash(accountId, connectionId, nativeChat)`, using `openwa-pilot:v1` salted by account/connection scope. We computed it only for scoped, authenticated native inbound chat identities **in read-only TEST SQL**; there was no application-level recipient transformation based on digits from an LID.

| Pre-send proof | Supplier A (`agent` workload) | Trusted Admin B (`api` workload) |
| --- | --- | --- |
| Exactly one account contact matches supplied phone | **YES** | **YES** |
| Exactly one same-session verified native conversation identity | **YES** (`@lid`) | **YES** (`@lid`) |
| Exact active/valid workload Pilot hash grant for that native chat | **YES: 1** | **YES: 1** |
| Grant has documented consent basis and attestation | **YES** | **YES** |
| Trusted active identity with `change_requests.approve` matching phone | Not required / no match expected | **YES: 1** |
| Grant configured message-per-recipient parameter | 100 | 1 |
| Recorded grant expiry (UTC, snapshot at read time) | **2026-11-20 22:48:46 UTC** | **2026-11-20 22:50:13 UTC** |

Provider/scoping checks at this snapshot: one unarchived OpenWA `ready` connection; Pilot ON; guardrail `manual_paused=false`; no currently open circuit; 24-hour reserved total 12 events across all workloads; 3 distinct reservation identities against the configured first-touch allowance 5; warmup effective hourly/day cap 500. These are **not** a promise of remaining capacity at dispatch or of provider availability. Admin B's configured allowance of 1 needs care: do not send a rehearsal PIN or unsolicited synthetic alert; only a genuine approved Change Request may trigger it.

Latest account-side TEST Cutover is `pilot`, readiness `true`, zero nonterminal Task, zero `sending`/`requires_reconciliation`/trigger-firing backlog according to the bounded account readiness RPC. TEST scheduling triggers remain 2 paused + 1 completed; not automatically started.

**Decision:** Account-scoped identity and Pilot recipient authorization = **VERIFIED** for *both* roles. Actual live operation = **HOLD** until WACRM operator proves exactly one worker owner (Windows or VPS), fresh grant expiry, correct session, approved Coverage Request, max-one first-touch test and click-through from WACRM's authenticated UI. This chat's Browser integration is **read-only** and cannot click the operator's open localhost WACRM tab; never bypass server auth using Supabase service-role writes. A user can perform the authenticated action in their WACRM app or switch into ChatGPT Work mode to enable authorized browser control; the next read-only TEST check can independently verify events and outcome.

### Next controlled operator action

1. On the local **WACRM → Agents → Agent Tasks** page, use worker STATUS and **Stop** (if enabled), then refresh. A stopped account worker is not proof a VPS poller is inactive; confirm actual runtime owner separately. Keep scheduled triggers paused.
2. In the existing Coverage module confirm/create the proper approved SOURCE request, distinct from supplier A. In Agent Tasks choose **Coverage**, select only Supplier A and the exact ready OpenWA session; cap at **one first contact**. Preserve contact consent and published Agent revision. Inspect and confirm the new Task with worker stopped, then **Pause** the task before delivery.
3. After recording an actual no-send/pause observation, allow exactly one authorized worker cycle and Resume the Task. Observe a single first-send reservation/provider identity before supplier A replies. Never retry unknown/ambiguous outcomes.
4. Supplier A answers explicitly that it **cannot provide coverage**; inspect inbound/Task state, no fabricated offer, and actual final disposition. Admin B is a separately trusted review recipient: **no approval-PIN message is expected for a refusal alone**.
5. Only if a distinct real review-required proposal is authorized, verify B's exact trusted-admin notification through the existing WACRM workflow. Later test STOP and final Cutover rollback + ordinary inbound, with fresh grant checks at each send.

## 0. STOP / GO before any actual WhatsApp message

**GO only if ALL:**
1. A and B supplied and individually confirmed as owned/controlled by operator, different, valid international phone numbers; their intended roles and any customer-to-provider contact relationship are unambiguous.
2. Correct Supabase TEST project + account and non-Production URL confirmed by authenticated WACRM admin.
3. Pin exact ready, nonarchived provider connection and live gateway state; never switch to a logged_out session, even if its Pilot says enabled. Session QR, key, tunnel URL must stay private.
4. Active, unexpired exact recipient grants/WhatsApp consent under the **selected session/workload**; request owner/admin capability and no opt-out/suppression; allowed daily/hourly caps for at most one first touch per supplier Task and only required authorized replies. Account-level `pilot` is distinct from session-level OpenWA Agent Pilot.
5. Worker **single runtime owner** (Windows or VPS), actual current state measured. Creating a Task while worker is already running may send immediately. Turn it off through the existing authorized operator UI BEFORE task creation as the test requires; do not mistake browser close for worker OFF.
6. No nonterminal old Tasks, no ambiguous/unknown active provider sends or outstanding reconciliation for the selected connection. Readiness summary is a necessary but not sufficient check; verify provider ACK/review pane.
7. Frozen source Coverage Request, account-scoped contacts, published agent version, target policy with `maxAttemptsPerTarget=1`, consent and cooldown. Admin notification destination verified separately. Existing Task/CRM Business Domain must remain source of truth.
8. Operator has agreed the maximum count and types of messages and accepts the bounded TEST test cases; stop/rollback plan and named operator available. CI-only/negative tests should not send provider messages.

Any unmet step = **HOLD; no WACRM API send, new Task creation or worker dispatch**.

## 1. Execution order — minimize sends, avoid repeating proven happy path

| Phase / cases | Operator action (authenticated WACRM TEST UI unless read-only evidence) | Pass evidence / deny |
| --- | --- | --- |
| P00 — no-send preflight | Record HEAD, CI, exact account/connection, A/B consent/role, operator, actual Windows/VPS worker owner, Pilot/caps, Task cutover and unknown outcomes | All gates valid, sign-off and UTC. No changes to old Tasks or settings |
| P01 — technical negative inspection | Triage prior inbound Run `SUPPLIER_WORKFLOW_FAILED` and Task with `partially_completed/paused_for_human` without Inbox owner | Incident cause and existing reconciliation; safe code-only evidence; never guess message result |
| P02 — task with paused worker | Create ONE new approved `coverage.sourcing@2` Task targeting A (not B unless separately approved as supplier), freeze contact/session and 1 first-touch attempt | New Task/Target IDs, 0 outbound while worker stopped; not a new 2-supplier pass |
| P03 — pause/resume, bounded send | Pause Task before start, verify no reservations through two *actual* worker cycles; resume explicitly and allow one approved first message to A | One reservation, one idempotency key, correct OpenWA provider ID and Task/Target match; never retry ambiguous |
| P04 — supplier refusal AC-06 | Operator answers from A with unambiguous “لا أستطيع توفير التغطية” | Real inbound linked to A, target terminal outcome, zero `coverage.offer.create`/approved supplier offer; final Task outcome honest |
| P05 — admin outcome | If native Coverage workflow has an admin review/notification, verify it arrives to B with correct safe summary and approval state; capture redacted trace | Evidence of real notification via WACRM business flow, not a parallel ad-hoc send; if no notification should occur by policy, mark N/A with reason |
| P06 — alternative-route AC-07 / takeover AC-08 | Prefer existing corroborated 17 Nov Task proof, signed by operator: alternative review was executed without offer, separate valid Target offer, human-staff Inbox assignment and `paused_for_human` | No new send merely to repeat evidence. If actual route/worker failure requires fix, retest separately with consent |
| P07 — worker restart AC-04 | Only after all previous sends have settled, operator safely stops actual Windows worker and restarts Next.js. Read-only trace before/after restart | Same Task/Target/Run/Reservation IDs, no extra first send, resume only if allowed; never restart in-flight provider send |
| P08 — scheduler SCH-6 | Use existing `ai_agent_task_triggers` with approved Coverage-only rule, verify once/recurring/event/skip/replay/cross-tenant/lease/recovery scenarios on TEST as separate checklist | Exact SCH-AC-01..11 records. Not implied by coverage Task. Do not unpause old triggers or run unrestricted interval |
| P09 — Opt-out AC-09 LAST before rollback | A sends explicit STOP; verify scoped suppression and no further outgoing Task send (dry-run/admission denial), no arbitrary number substitution | Once opted out, **do not** use A for more outbound tests or automatically reauthorize it |
| P10 — rollback AC-12 | After provider outcome reconciliation and scheduler admission stop, authenticated operator clicks Agent Task Cutover disabled + worker stop, checks readiness | `mode=disabled`, outbound Task delivery and WhatsApp Task scope disabled, zero sending/reconciliation, no new Task send |
| P11 — post-rollback inbound AC-13 | B sends one ordinary incoming WhatsApp message (if B is an appropriate consenting test contact); verify unified WACRM CRM Inbox intake | Inbound received, no reactivation of old Tasks, no outbound Task. This is not automatically a supplier reply |

**For final SOF-66 multi-target negative acceptance:** use previously attested 2-target happy path plus cases now tested (if DoD accepts equivalent), or run another authorized 2-supplier TEST task with a SECOND supplier distinct from B's admin role. Avoid conflating supplier and admin responsibilities.

## 2. Record actual evidence, not "ready" labels

Use the existing signed acceptance register `23_SOF66_PHASE18_PHASE19_ACCEPTANCE_EVIDENCE_REGISTER.md` and latest partial corroboration `27_SOF66_PHASE18_PHASE19_2026_11_20_USER_TEST_RECONCILIATION.md`.

Per case enter: ID, UTC date/time, exact HEAD, TEST account internally, selected provider/connection ID (private), A/B aliases and private consent snapshot, Task/Target/Run/Reservation IDs, chosen agent revision, source Coverage Request, pre/post runtime state, expected vs observed result, safe reason code, provider reconciliation if unknown, evidence link, operator reviewer and `PASS/FAIL/BLOCKED`. Do not put phone numbers, messages, keys or raw webhooks in public repo or Linear comments.

**Stop immediately** on wrong connection, unexpected third party, missing consent, wrong Target mapping, multiple first sends, fresh unknown send, human takeover followed by AI sending, unapproved offer, leaked QR/secret, non-TEST DB, or concurrent Windows/VPS workers. Preserve evidence and keep issues open.

## 3. Exit decisions and rollback gates

- SOF-24 = PASS only with real refusal, safe route review-only, effective human handoff and honest no-offer completion. Prior strong AC07/08/11 partial evidence may support but cannot replace operator sign-off.
- SOF-66/SOF-23 = PASS only after bounded multi-target, appropriate no-duplicate/opt-out/restart/reconciliation, Cutover rollback to disabled and post-rollback inbound. Historic positive proof alone is insufficient.
- SOF-18 = PASS only after independent signed SCH-6 operational matrix (once/recurrence/event/lease/backlog/security/rollback).
- SOF-26 = **Builder staged rollout remains disabled** until corresponding signed proof, operator role/account gates and server-side release transition; Phase22 cleanup stays inventory-only.
- Service Promotion SOF-17/25 deferred, W06 DR deferred, W07/W08/W09 and NOTE-001 independent Production blockers not waived.
- This runbook is preparation only. **It does NOT claim or execute a WhatsApp send.**
