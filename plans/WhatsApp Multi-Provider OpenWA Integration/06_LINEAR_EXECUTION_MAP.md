# Linear Execution Map — WhatsApp Multi-Provider + OpenWA

## Dedicated Linear project
Create a project separate from `WACRM — AI Agent Task & Outreach Platform V1`.

Recommended name:
`WACRM — WhatsApp Multi-Provider & OpenWA Integration`

Team: `Software engineer`

Purpose: plan, implement, verify and roll out the provider-neutral WhatsApp layer and optional OpenWA transport without mixing its lifecycle with the Agent Task project.

## Milestones / phases
Create one milestone per engineering phase:
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
Each milestone receives a primary phase issue plus implementation/test issues as needed after the phase starts. Do not pre-claim exact migration filenames before OW-1 inventories the latest migration sequence. Every phase issue must contain:
- objective
- affected current files/tables
- proposed new files/migrations
- security/tenant requirements
- tests
- Meta regression gate
- acceptance evidence
- rollback/stop condition
- Definition of Done level

## Dependency chain
OW-0 → OW-1 → OW-2 → OW-3 → OW-4 → OW-5 → OW-6 → OW-7 → OW-8 → OW-9 → OW-10 → OW-11 → OW-12 → OW-13 → OW-14.

Some implementation can later overlap after contracts stabilize, but Linear should preserve these gates. In particular, live TEST/pilot/rollout cannot be marked complete from code-only evidence.

## Source links
Phase issues should link back to this plan directory in GitHub and, where relevant, to exact implementation commits/CI runs/migrations. The project description should identify `refactor/service-platform-v2` as the implementation source of truth.
