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
- OW-4 — Session Lifecycle & QR Onboarding (SOF-33): live TEST session creation, QR, Ready VERIFIED; In Progress pending current-HEAD CI/Meta regression.
- OW-5 through OW-11 (SOF-34..SOF-40): implementation phase issues Done with historical CI/TEST evidence; not a claim of full live acceptance.
- OW-12 (SOF-41): current execution phase, In Progress with partial live TEST: Webhook 202, inbound, native @lid, agent outbound and read ack verified.
- OW-13/OW-14: not started; no pilot/production rollout approval.

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

Phase implementation closure never implies OW-12 live acceptance or production readiness. SOF-33 remains open for the current-HEAD CI gate; SOF-41 remains open for untested live scenarios. NOTE-001 is still a production-readiness dependency. See the 2026-11-07 Linear evidence document linked below.


## Live TEST / Linear reconciliation — 2026-11-07

- Latest implementation HEAD before documentation sync: `91e628e03aa8e615b8a6c5e5ca924a1e062e849f`.
- Current Linear project status updated from Planned to In Progress; OW-0..OW-12 issue-to-milestone mappings reconciled. SOF-32 remains Duplicate of SOF-33.
- Canonical 2026-11-07 evidence: [OpenWA live TEST checkpoint](https://linear.app/eproo/document/openwa-live-test-checkpoint-2026-11-07-ow-4-ow-12-1e473cda8576).
- OW-4 live session/QR/Ready verified but its `fresh CI/Meta regression` closure criterion is not yet satisfied by a run on the current implementation. Keep SOF-33 In Progress until an acceptable new CI result is linked.
- OW-12 has partial live acceptance and cannot close. `@lid` routing fix and TEST migrations `147`, `148`, `150`, `151` are recorded with read receipt success, outstanding old ambiguous send and untested scenarios.
