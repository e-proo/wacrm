# WACRM — Service Promotion Agent: Phase 12 / Phase 20 execution & acceptance plan

**Scope:** SOF-17 (Phase 12 — Service Promotion / Sales Agent), SOF-25 (Phase 20 — bounded Service Promotion Pilot).  
**Status:** IMPLEMENTATION PLAN — not a claim of completed TEST acceptance or permission to send WhatsApp.  
**Repository/branch inspected:** `e-proo/wacrm` / `refactor/service-platform-v2`. **Code/CI baseline:** `779c7910677049dd5a62394440861a1e9051c513`; [CI success](https://github.com/e-proo/wacrm/actions/runs/44005517505). **Date:** 2026-11-17.  
**Dependencies:** [Master V1 plan](10_AI_AGENT_TASK_AND_OUTREACH_PLATFORM_V1.md), [Coverage bounded acceptance pack](20_SOF66_PHASE18_PHASE19_TEST_ACCEPTANCE_PACK.md), SOF-16 completed at one-supplier TEST level. SOF-66/SOF-23/SOF-24 are **not signed off** simply by that pack.

## 1. Product outcome & non-goals

Deliver an agent that converts an **operator-approved, bounded WhatsApp offer** for one active CRM service into measurable commercial outcomes: delivered/contacted → inbound reply → qualified `Intent` or Service Request where the domain allows → staff handoff or auditable not-interested/opt-out outcome → factual Task/Target completion. A sent message is **not** a sale, successful lead, or accepted service order.

**Not in scope:** generic bulk marketing; unrestricted address-book scanning; autonomous price changes/discounts; automatic business commitment or payment; new campaign/broadcast engine; bypass of Meta template approval or WhatsApp consent; automatic Production activation. Existing `broadcasts` remain their own business workflow; promotion tasks use the shared Agent Task runtime, WhatsApp transport and CRM identity.

## 2. Verified code baseline — extend, do not duplicate

| Existing capability | Source | Observed condition / required follow-up |
|---|---|---|
| Registered `services.promotion@1`, tools `services.get@1`, `services.match_request@1`, `intents.record@1` | `src/lib/services/service-catalog/agent-task.ts`, `src/lib/ai/tasks/current-platform.ts` | Task manifest exists; business outcome integration must be proven end-to-end |
| Tagged audience resolver | `service-catalog/agent-task.ts` | Resolves `contact_tags` from required tags and uses generic admission; frozen **tag criteria** are not a proven frozen membership list. Audit tenant scoping, pagination and consent prior to approval |
| Task creator, Builder capability checks, scoped service snapshot, dedup key | `service-catalog/agent-task-service.ts` | Present; active-task detection currently finds an active Task for the **same service**, irrespective of campaign/segment. Specify explicit duplicate and overlap policy |
| Template message policy | `service-catalog/agent-task.ts` | Defaults to `service_promotion_v1` / `ar`; confirm approved template/version/language/parameters **on chosen Meta connection**, and provider-specific first-touch rules |
| Readiness inspector | `service-catalog/pilot-readiness.ts` | Checks 1–3 eligible TEST contacts, published revision, approved local template and cutover. Extend to exact connection/session, consent proof, worker state and settled outbound evidence |
| Generic outbound/recipient guards | `src/lib/ai/tasks/outbound-runtime.ts`, `outbound-worker.ts`, `target-resolution.ts`, `reply-correlation.ts` | Reuse approved Meta/OpenWA adapter; no bypass, provider secrets, ambiguous resend or parallel sender |
| Service promotion trigger | `service-catalog/agent-task-trigger.ts` | **Schedule only**; business-event promotion trigger is explicitly rejected. Do not describe unsupported events as working |
| Operator UI | `src/components/agents/agent-outreach-builder.tsx`, `agent-tasks-panel.tsx`, `src/app/api/agent-tasks/route.ts` | Builder has Service binding fields; current Task creation UI/API is Coverage-oriented. Dedicated promotion workflow is needed |
| Automated baseline | `service-catalog/agent-task.test.ts`, `service-catalog/pilot-readiness.live.test.ts`, `supabase/ci/agent-task-*.sql` | Contract/smoke evidence exists, **not** proof of multi-turn live Service Promotion pilot |

## 3. Desired business workflow

```text
Approved Service + immutable published revision + offer/template
   ↓
Audience preview (explicit tagged cohort, exact tenant + consent) → operator approval
   ↓
Frozen campaign identity + recipient snapshot + selected WhatsApp connection
   ↓
Agent Task → per-recipient Target → bounded idempotent outbound reservation
   ↓
Meta approved template OR OpenWA policy-compliant message
   ↓
Inbound through unified WACRM pipeline + exact Task Target correlation
   ├─ interested → collect needs → intents.record@1 / domain-approved Request → human follow-up
   ├─ needs clarification → factual service/pricing from authorized read tools
   ├─ not interested → terminal declined, no more outreach
   ├─ opt-out → durable suppression, no more outreach
   └─ human takeover → Task Target paused_for_human and staff owns the conversation
   ↓
Audit-friendly outcomes, Task status, customer follow-up queue, campaign summary
```

## 4. Implementation work packages (sequence and acceptance contracts)

### SP-0 — Baseline freeze / contract & threat review
- Inspect current HEAD, migrations 109/110/113/119/121–127/133/139/158–170, current service/intent schemas, outbound adapters, Inbox takeover and current TEST pilot flags; record existing tests and CI.
- Map exact `Intent` fields, actor permissions and downstream Service Request lifecycle. **Do not invent a second lead table** if `customer_intents` (or a native existing entity) already represents the outcome.
- Document target statuses and a transition table: `candidate → admitted → contacted → interested/declined/opted_out/paused_for_human/failed`. Define authoritative DB evidence for every transition; language model can classify/propose, but cannot assert a committed business outcome.
- Deliverable: versioned schema/sequence diagram, failure-mode table, security review of service ownership, roles and identity.

### SP-1 — Cohort preview, exact snapshot, and campaign identity
- Add account-scoped **preview endpoint** returning count, consent/eligibility blockers, excluded tags, cooldown, first-touch and transport suitability; no send/no materialization.
- Fix/verify explicit tenant scope for `contact_tags` (query currently selects tag IDs without an explicit account predicate), joins to account contacts, deterministic pagination (no silent LIMIT truncation). Keep service-role restricted by account predicates; DB materialization remains final authority.
- Freeze selected **recipient IDs and selection order** at operator approval or freeze a verifiably stable snapshot referenced by Task; guard changes between preview, approval and worker tick. Never silently expand a previously approved cohort.
- Define `campaign_key` / snapshot revision / launch window and a per-contact suppression/duplicate window across active and historical campaigns. Existing active-service dedup must not merge unrelated tag segments or conceal overlapping campaigns.
- Capture opt-in type, provenance, timestamp, expiration and exact channel; contact eligibility **recommendation** may inform manual choice but opt-out/legal/provider/session restrictions remain hard blockers.
- Acceptance: same preview/approval yields same exact cohort; stale preview demands reconfirmation; foreign contact/tag rejected; paused/missing consent never admitted.

### SP-2 — Operator UX and authorization
- Extend `/agents` with **إنشاء مهمة ترويج خدمة**: service picker, published agent, connection picker, segment selector/tag preview, message/template preview, limits, schedule choice, dry-run readiness and explicit confirmation.
- Introduce account-scoped `/api/agent-tasks/promotion` and read-only `/api/agent-tasks/promotion/preview` (suggested paths; conform to established route patterns). Validate `agents.manage_tasks` and `agents.manage_outreach`/appropriate role; do not trust client IDs, audience or template state.
- Show per-contact `reason`, delivery/provider message IDs, inbound status, Intent/Request link, staff handoff and aggregated outcomes. Existing pause/resume/cancel/worker buttons continue to work.
- No automatic Pilot enablement, no hidden auto-send on draft creation, no arbitrary bulk recipient entry outside approved TEST scope.

### SP-3 — Message/transport compliance and provider parity
- Lock a service snapshot, template identity/language/approved parameters, selected `whatsapp_connections.id` and provider at Task approval. Meta default production adapter stays Meta; OpenWA optional TEST/self-hosted transport.
- Verify Meta approved template status and exact language/parameter mapping; open 24-hour session allows permitted free-text only. OpenWA TEST cohort grants, opt-in, channel guardrails, budget, connection readiness and no-blind-retry are checked both on reservation and pre-dispatch.
- All outbound paths go through **the existing Agent Task reservation and unified WhatsApp transport**, with provider-neutral status reconciliation; never send from the AI tool or build a competing queue.
- Send suppression after STOP/opt-out, duplicate campaign, hours/cooldown limits, staff takeover or kill-switch must win even after an earlier preview.
- Acceptance: one initial reservation per approved recipient; no wrong connection/provider; timeout with uncertain outcome requires reconciliation, not resend.

### SP-4 — Multi-turn sales conversation and native business result
- Route inbound using existing `correlateInboundTaskReply` with exact `account_id`, `contact_id`, `connection_id`, `conversation_id`, `task_target_id`. Ignore unverified LID identity until proven under unified WhatsApp pipeline; no guessed phone from `@lid`.
- Agent uses published, allowed tools to explain service using current *approved* service/pricing facts. Classification categories: interested / request details / later / not interested / opt-out / staff needed.
- For interest, invoke `intents.record@1` only with validated structured fields and deterministic task-target idempotency; create an actual service request only via an existing domain-authoritative action/approval where supported.
- Persist Intent/Request ID, conversation and Target relationship; expose it in UI and audit. Prevent duplicate Intent on repeated webhook/recovery, repeated model calls or two workers.
- Human takeover must stop **Task Target** and AI auto-reply, not just change Inbox `assigned_agent_id`; test both controls and their interaction.

### SP-5 — Honest completion and business analytics
- Replace or refine `services.promotion_completion@1` behavior: today `all_targets_terminal` may report `completed` even when all Targets are opt-out/failed. Define success by durable intent/handoff/business outcome, and separately distinguish `completed`, `partially_completed`, `failed`, `cancelled` by policy and case.
- Report distinct counts: selected, eligible, skipped (with reasons), attempted, accepted-by-provider, delivered (when evidenced), replied, qualified intents, service requests, opted out, handed off, failures, unsettled. **Never equate `sent` with `read` or `sale`.**
- Optional bounded follow-up only where configured, within working hours and stop-on-reply/opt-out/outcome, with idempotency and a separate operator-approved allowance.

### SP-6 — Tests, security, rollback and observability
- Unit/integration: audience snapshot, foreign account/tag/service, 0/3/100 contacts, tag mutation, opt-out, expired consent, duplicate campaign, stale preview, appointment/window and dedup.
- Provider matrix: Meta approved/missing template and session-window, OpenWA opted-in test cohort and disabled Pilot, wrong/stale connection, LID unresolved, ambiguous timeout, ack reconciliation, retry/replay.
- Inbound/outcomes: interested → single Intent with exact Target; decline; STOP; staff takeover; duplicate webhook; missing service/pricing; closed task; multi-recipient cross-talk isolation.
- SQL smoke: service-role scope, RLS, joins and unique keys, immutable snapshot and tenant isolation, durable behavior after kill-switch/restart. Add additive migrations only; TEST apply and clean replay.
- CI: lint/typecheck/Vitest/full build plus migrations workflow on exact schema-bearing SHA. Attach case IDs and redacted evidence, record failure/rollback.

### SP-7 — SOF-25 bounded live TEST acceptance
- Preconditions: SOF-17 automated gates pass, published agent revision, *one* active TEST service, approved template (or policy-compliant TEST OpenWA alternative), **1–3 explicitly consenting controlled TEST contacts**, matching tags and session grants, worker/pilot readiness snapshot. Operator alone authorizes sends.
- AC-SP-01 preview+freeze → matches exact 1–3 contacts; no contact added behind approval.
- AC-SP-02 one initial message each, right provider/template/connection/ID, no ambiguity/duplicate.
- AC-SP-03 one customer expresses interest → ONE durable Intent/Request (and owner/task link), no invented sale.
- AC-SP-04 another asks questions → contextual, approved service information only.
- AC-SP-05 negative reply and STOP → terminal decline/opt-out, zero future promotion messages.
- AC-SP-06 human takeover → no agent Task continuation; staff queue populated.
- AC-SP-07 replay/restart → same campaign/task/outbound/Intent identities, no additional initial sends.
- AC-SP-08 pause, resume, disable cutover/worker and test ordinary inbound after rollback.
- AC-SP-09 verify honest Task completion and campaign counters against DB evidence.
- Store timestamps, anonymized contact IDs, Task/Target/Run/Reservation/provider IDs, Intent/Request IDs, worker/cutover state, TEST/CI refs and PASS/FAIL/BLOCKED per case. No live Meta claim from OpenWA-only runs.

## 5. Definition of Done and gates

**SOF-17 — implementation complete:** exact source-reviewed capability with immutable cohort, UX/API, role+tenant controls, real Intent/Request correlation, truthful completion policy, provider-neutral routing and automated negative tests. **TEST verified:** migrations applied/read-only inspected, clean replay + full CI success.  
**SOF-25 — live TEST acceptance complete:** approved bounded operator-run SP-01..09 with evidence and verified rollback; failed/blocked cases keep the issue open.  
**Production ready:** separately gated by NOTE-001/Supabase advisors, true Production runner/scheduler, WhatsApp consent/template policy, alerts/costs/security and graduated release. Do not change Production or widen Pilot in this plan.

## 6. Rollback, observability and ownership

- **Operator controls:** pause Task, disable Agent Task outbound + stop account worker, keep other WACRM inbound, avoid resetting separate OpenWA session Pilot unless deliberately required. Reconcile any in-flight/ambiguous reservation before retry decisions.
- **Metrics:** `promotion_targets_admitted`, `promotion_initial_sent`, `promotion_replied`, `promotion_intents_created`, `promotion_opt_out`, `promotion_handoff`, `promotion_reconciliation_pending`, `promotion_policy_denial` by account/task/provider; no PII/secret content in telemetry.
- **Evidence owner:** engineering signs code/CI/TEST; authorized TEST operator signs WhatsApp consent and live SP acceptance; product owner signs truthful business outcome; security signs production gate.
- **Dependencies:** SOF-66/SOF-23/SOF-24 acceptance must not be inferred from their checklist; SOF-18 schedule acceptance is independent but reuses this Task contract.

**Implementation order:** SP-0 → SP-1 → SP-2/SP-3 → SP-4 → SP-5 → SP-6 → SP-7. Pause at every gate; no sends or Production changes are authorized by this design document.
