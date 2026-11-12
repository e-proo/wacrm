# Linear Execution Map — WhatsApp Multi-Provider + OpenWA

## Dedicated Linear project
Project: `WACRM — WhatsApp Multi-Provider & OpenWA Integration`

Identifier: `P-SOF-2`

Team: `Software engineer`

Purpose: plan, implement, verify and roll out the provider-neutral WhatsApp layer and optional OpenWA transport without mixing its lifecycle with the Agent Task project.

## Current execution status
- OW-0 — Baseline & Contract Freeze: COMPLETE.
- OW-1 — Provider-Neutral Data Model: COMPLETE at implementation + TEST + CI verified.
- OW-2 — Meta Adapter Extraction: COMPLETE at implementation + CI verified.
- OW-3 — OpenWA Client & Credential Boundary: COMPLETE at implementation + TEST/migration/security evidence + CI verified.
- OW-4 — Session Lifecycle & QR Onboarding (SOF-33): **Done** at implementation complete + live TEST create/QR/Ready verified + current merge-HEAD CI/Migrations/Meta regression green.
- OW-5 through OW-11 (SOF-34..SOF-40): implementation phase issues Done with historical CI/TEST evidence; not a claim of full live acceptance.
- OW-12 (SOF-41): current execution phase, In Progress with partial live TEST: Webhook 202, inbound, native @lid, agent outbound and read ack verified.
- OW-13: preparation In Progress (SOF-42/SOF-44); formal pilot Todo/blocked (SOF-43) pending OW-12. OW-14 **planning prepared** under existing OW-14 milestone; release approval and production rollout NOT STARTED / NO-GO.

OW-1 Linear issue:
- `SOF-29 — OW-1 — Implement provider-neutral WhatsApp connection data model and tenant RLS`
- Status: `Done`
- Verified implementation HEAD: `31fa9f998099733cd3788c85f151c14444d1eb3c`
- Migrations run `40012212695`: success
- CI run `40012212709` / #781: success

OW-2 Linear issue:
- `SOF-30 — OW-2 — Extract Meta behind provider-neutral WhatsApp transport boundary`
- Status: `Done`
- Closure level: implementation complete + CI verified
- Verified implementation HEAD: `431eed953c06c2c55f4bb80b6445d16464682e67`
- CI run `40025933870` / #799: success

OW-3 Linear issue:
- `SOF-31 — OW-3 — Implement OpenWA REST client and credential boundary`
- Status: `Done`
- Closure level: implementation complete + TEST/migration/security evidence + CI verified
- Verified implementation HEAD before closure documentation commits: `92d394a9931b45d97b1c83a9146cc3dbf6edda72`
- CI run `40030486765` / #810: success (lint + typecheck + tests + build)
- Migrations run `40029970213` / #404: success (clean replay + verification suites)
- TEST migration application: success
- Supabase security recheck: no new OW-3 `rls_enabled_no_policy` debt after additive deny policies; pre-existing NOTE-001 remains.
- OpenWA runtime routing remains disabled.

## Milestones / phases
- OW-0 Baseline & Contract Freeze
- OW-1 Provider-Neutral Data Model
- OW-2 Meta Adapter Extraction
- OW-3 OpenWA Client & Credential Boundary
- OW-4 Session Lifecycle & QR Onboarding
- OW-5 Signed OpenWA Webhook Intake
- OW-6 Unified Inbound Normalization
- OW-7 OpenWA Outbound Text & Reply
- OW-8 Media
- OW-9 Ack, Status & Reconciliation
- OW-10 Safety & Anti-Abuse Guardrails
- OW-11 Agents, Automations & Broadcast Routing
- OW-12 Live TEST Acceptance
- OW-13 Bounded Pilot
- OW-14 Production Rollout Decision

## Issue convention
Each milestone receives a primary phase issue plus implementation/test issues as needed after the phase starts. Every phase issue must contain objective, affected current files/tables, proposed new files/migrations when applicable, security/tenant requirements, tests, Meta regression gate, acceptance evidence, rollback/stop condition and Definition of Done level.

## Dependency chain
OW-0 → OW-1 → OW-2 → OW-3 → OW-4 → OW-5 → OW-6 → OW-7 → OW-8 → OW-9 → OW-10 → OW-11 → OW-12 → OW-13 → OW-14.

Some implementation can later overlap after contracts stabilize, but Linear must preserve these gates. In particular, live TEST/pilot/rollout cannot be marked complete from code-only evidence.

## Evidence discipline
GitHub code/current branch is the implementation source of truth. CI/TEST evidence determines verification level. Linear records execution state and must be synchronized only after the phase Definition of Done is demonstrated.

Phase issues should link to this plan directory and, where relevant, exact implementation commits, migrations and CI runs. The implementation source of truth remains `refactor/service-platform-v2`.

Phase implementation closure never implies OW-12 full live acceptance or production readiness. SOF-33 closure gate is verified at merge HEAD `c87fd13c`; SOF-41 stays In Progress for untested live scenarios. NOTE-001 remains a production-readiness dependency. See the 2026-11-07 Linear evidence document linked below.


## Live TEST / Linear reconciliation — 2026-11-07

- Latest implementation HEAD before documentation sync: `91e628e03aa8e615b8a6c5e5ca924a1e062e849f`.
- Current Linear project status updated from Planned to In Progress; OW-0..OW-12 issue-to-milestone mappings reconciled. SOF-32 remains Duplicate of SOF-33.
- Canonical 2026-11-07 evidence: [OpenWA live TEST checkpoint](https://linear.app/eproo/document/openwa-live-test-checkpoint-2026-11-07-ow-4-ow-12-1e473cda8576).
- OW-4 live TEST create/QR/Ready verified; the fresh CI/Meta regression gate is satisfied after [PR #3](https://github.com/e-proo/wacrm/pull/3) merged at `c87fd13cf68df1cc6757fd910a7761e9110ff411` on 2026-11-07. [CI #42410328689](https://github.com/e-proo/wacrm/actions/runs/42410328689) and [Migrations #42410328723](https://github.com/e-proo/wacrm/actions/runs/42410328723) both `completed/success` on exact merge HEAD, including OW-4 QR/tenant/credential smoke. TEST additive migration `152_openwa_service_role_credential_grants.sql` applied and role permissions verified. SOF-33 is eligible for Done at `implementation complete + TEST QR/session verified + CI verified`.
- OW-12 has partial live acceptance and cannot close. `@lid` routing fix and TEST migrations `147`, `148`, `150`, `151` are recorded with read receipt success, outstanding old ambiguous send and untested scenarios.

## OW-13 planning vs execution — 2026-11-11

- New plan: [08_OW13_BOUNDED_PILOT_PREPARATION.md](08_OW13_BOUNDED_PILOT_PREPARATION.md).
- [SOF-42](https://linear.app/eproo/issue/SOF-42/ow-13-prep-prepare-bounded-openwa-pilot-controls-monitoring-and) owns the preparation runbook, control gap inventory, staged cohort, observability and rollback evidence.
- [SOF-43](https://linear.app/eproo/issue/SOF-43/ow-13-execute-bounded-openwa-pilot-after-ow-12-live-acceptance-not) owns future live bounded pilot execution; blocked by SOF-41 and SOF-42 until all gates and written approval pass.
- OW-12/SOF-41 remains In Progress and must still verify real-provider ambiguous reconciliation, remaining live acceptance matrix and same-TEST Meta regression. No pilot or Production traffic was enabled.


## OW-14 preparation / Linear execution contract — 2026-11-12

- Existing project `P-SOF-2`, existing milestone `OW-14 — Production Rollout Decision` (no duplicate project/milestone). Planning may overlap with OW-12 and OW-13, but formal production release approval is downstream of complete OW-12 and OW-13 acceptance.
- Canonical plan: [10_OW14_PRODUCTION_READINESS_AND_ROLLOUT_PLAN.md](10_OW14_PRODUCTION_READINESS_AND_ROLLOUT_PLAN.md), stages P0–P5 and W01–W10. Decision template: [11_OW14_RELEASE_DECISION_TEMPLATE.md](11_OW14_RELEASE_DECISION_TEMPLATE.md). Each workstream issue requires scope, source files/evidence, verification, owner, rollback and a precise acceptance level.
- Create PREP/engineering workstream tasks under existing OW-14 milestone. Keep release decision and production wave tasks **Todo/blocked** by SOF-41 OW-12, SOF-43 OW-13 formal pilot, NOTE-001 item-level security disposition, verified current SHA/CI/Migrations and explicit approvals. No implicit authorization or state promotion from planning.
- Source baseline before planning commits: HEAD `3175c541d2a33851593a6ed45042e62ca7186a3c`, CI `43298734037` success and migrations `43297752814` success. Refresh for new HEAD; older historical inventory and pending-send snapshots are not current.
- Owner explicitly **deferred** remaining live TEST gates; deferral does not equal `TEST verified`, `live acceptance complete` or `production ready`. Do not mark OW-14 milestone Done until actual staged rollout and independent signoff evidence passes.

## OW-14 exact workstream issue map — 2026-11-12

Planning [SOF-58](https://linear.app/eproo/issue/SOF-58); baseline [SOF-48](https://linear.app/eproo/issue/SOF-48); gateway [SOF-49](https://linear.app/eproo/issue/SOF-49); security/NOTE-001 [SOF-50](https://linear.app/eproo/issue/SOF-50); telemetry/on-call [SOF-51](https://linear.app/eproo/issue/SOF-51); webhook/outbound reliability [SOF-52](https://linear.app/eproo/issue/SOF-52); capacity/backup [SOF-53](https://linear.app/eproo/issue/SOF-53); opt-in/UX [SOF-54](https://linear.app/eproo/issue/SOF-54); release CI/migrations [SOF-55](https://linear.app/eproo/issue/SOF-55); **release decision blocked** [SOF-56](https://linear.app/eproo/issue/SOF-56); **production wave blocked** [SOF-57](https://linear.app/eproo/issue/SOF-57). All belong to the existing milestone OW-14, not a new project.

Next possible non-production task: **SOF-48 read-only baseline/topology audit**. Formal GO remains NO-GO while SOF-41/SOF-43 and security/ops gates remain open.
