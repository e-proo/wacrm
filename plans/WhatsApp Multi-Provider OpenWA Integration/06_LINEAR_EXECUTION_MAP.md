# Linear Execution Map — WhatsApp Multi-Provider + OpenWA

## Dedicated Linear project
Project:
`WACRM — WhatsApp Multi-Provider & OpenWA Integration`

Identifier: `P-SOF-2`

Team: `Software engineer`

Purpose: plan, implement, verify and roll out the provider-neutral WhatsApp layer and optional OpenWA transport without mixing its lifecycle with the Agent Task project.

## Current execution status
- OW-0 — Baseline & Contract Freeze: COMPLETE.
- OW-1 — Provider-Neutral Data Model: COMPLETE at implementation + TEST + CI verified.
- OW-2 — Meta Adapter Extraction: NEXT / current execution phase.
- OW-3 through OW-14: not started; preserve dependency gates.

OW-1 Linear issue:
- `SOF-29 — OW-1 — Implement provider-neutral WhatsApp connection data model and tenant RLS`
- Status: `Done`
- Verified implementation HEAD before documentation commits: `31fa9f998099733cd3788c85f151c14444d1eb3c`
- Migrations run `40012212695`: success
- CI run `40012212709` / #781: success

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
Each milestone receives a primary phase issue plus implementation/test issues as needed after the phase starts. Every phase issue must contain:
- objective
- affected current files/tables
- proposed new files/migrations when applicable
- security/tenant requirements
- tests
- Meta regression gate
- acceptance evidence
- rollback/stop condition
- Definition of Done level

## Dependency chain
OW-0 → OW-1 → OW-2 → OW-3 → OW-4 → OW-5 → OW-6 → OW-7 → OW-8 → OW-9 → OW-10 → OW-11 → OW-12 → OW-13 → OW-14.

Some implementation can later overlap after contracts stabilize, but Linear must preserve these gates. In particular, live TEST/pilot/rollout cannot be marked complete from code-only evidence.

## Evidence discipline
GitHub code/current branch is the implementation source of truth. CI/TEST evidence determines verification level. Linear records execution state and must be synchronized only after the phase Definition of Done is demonstrated.

Phase issues should link to this plan directory and, where relevant, exact implementation commits, migrations and CI runs. The implementation source of truth remains `refactor/service-platform-v2`.

OW-1 closure does not imply production readiness. NOTE-001 and later live acceptance, bounded pilot and rollout gates remain open concerns for their appropriate phases.
