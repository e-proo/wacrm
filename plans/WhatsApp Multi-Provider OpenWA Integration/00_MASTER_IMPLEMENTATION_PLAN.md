# WACRM — WhatsApp Multi-Provider + OpenWA Integration

Status: EXECUTION IN PROGRESS — OW-0 through OW-3 closed; OW-4 implementation complete and CI verified, awaiting live TEST session/QR acceptance before closure.

## Objective
Add OpenWA as an optional self-hosted WhatsApp Web transport while preserving Meta WhatsApp Cloud API as the official/default production transport. WACRM remains the source of truth for CRM/business logic/agents/automations/broadcasts/audit/idempotency.

## Source-of-truth baseline
- Repository: `e-proo/wacrm`
- Branch: `refactor/service-platform-v2`
- OW-1 verified implementation HEAD: `31fa9f998099733cd3788c85f151c14444d1eb3c`
- OW-2 verified implementation HEAD: `431eed953c06c2c55f4bb80b6445d16464682e67`
- OW-3 verified implementation HEAD: `92d394a9931b45d97b1c83a9146cc3dbf6edda72`
- OW-4 implementation HEAD: `ccb421426bf8e3dcc305db3a2ad5faaba6230711`
- OW-4 implementation CI: GitHub CI #822 / run `40031691828` = `completed/success` (lint, typecheck, tests, build)
- Current execution phase: `OW-4 — Session Lifecycle & QR Onboarding`
- Project-wide Supabase security debt remains tracked by `PROJECT_NOTES.md` NOTE-001 and is a production-readiness dependency.

## Verified execution status
| Phase | Status | Evidence level |
|---|---|---|
| OW-0 | COMPLETE | contract/baseline freeze |
| OW-1 | COMPLETE | implementation complete + TEST verified + CI verified |
| OW-2 | COMPLETE | implementation complete + CI verified; Meta regression gate passed |
| OW-3 | COMPLETE | implementation complete + TEST migration/security evidence + CI verified |
| OW-4 | IMPLEMENTATION COMPLETE / CI VERIFIED | live TEST session creation + QR acceptance still required by phase exit gate |
| OW-5..OW-14 | NOT STARTED | gated by preceding phases |

## OW-4 implementation evidence
- OpenWA REST client exposes create/status/QR/reconnect/logout session primitives while retaining the OW-3 timeout, SSRF, redaction and error boundary.
- `src/lib/whatsapp/transport/openwa/session-lifecycle.ts` normalizes lifecycle states and rejects stale transitions that would revive `restricted` or `logged_out` sessions.
- `src/lib/whatsapp/transport/openwa/session-auth.ts` requires an authenticated admin+ account member before session operations and only then creates a server-side service-role database client; service-role lookups remain explicitly account + connection scoped.
- `/api/whatsapp/connections/openwa` provides admin-scoped list/create. API keys are encrypted before persistence and are not returned to the browser.
- `/api/whatsapp/connections/openwa/[connectionId]` provides account-scoped status refresh, reconnect and logout.
- `/api/whatsapp/connections/openwa/[connectionId]/qr` returns QR material only to an authorized admin, sets no-store/private/no-cache response headers, caps QR lifetime to 60 seconds, rejects expired QR material and does not persist QR data.
- `src/components/settings/openwa-connections.tsx` integrates optional OpenWA onboarding into the existing WhatsApp settings surface; the OpenWA dashboard is not exposed.
- Meta Cloud remains visibly the official/default production provider and no OpenWA outbound business routing was enabled.
- Unit coverage includes session client methods plus normalized state alias/terminal-transition behavior.
- GitHub CI #822 / run `40031691828` passed lint, typecheck, tests and build at implementation HEAD `ccb421426bf8e3dcc305db3a2ad5faaba6230711`.

## OW-4 remaining closure gate
The detailed OW-4 plan requires TEST to create a non-production OpenWA session and safely display a short-lived QR to an authorized admin. That is a live external-provider acceptance step: it requires a reachable TEST OpenWA service and its server-side API credential. Until that evidence exists, OW-4 is **implementation complete + CI verified**, not `TEST verified`/closed.

## Architectural decision
Meta Cloud remains the official/default production provider. OpenWA is an optional self-hosted transport. WACRM owns CRM/business logic/agents/automations/broadcasts/audit/idempotency; OpenWA owns linked-device transport/session mechanics only. Provider values are `meta_cloud` and `openwa`; OpenWA engines are `whatsapp-web.js` and `baileys` metadata, never business-caller choices.

## Phase map
| Phase | Name | Primary gate |
|---|---|---|
| OW-0 | Baseline & Contract Freeze | architecture/compatibility |
| OW-1 | Provider-Neutral Data Model | migrations + RLS |
| OW-2 | Meta Adapter Extraction | zero Meta behavior regression |
| OW-3 | OpenWA Client & Credential Boundary | client/security contract |
| OW-4 | Session Lifecycle & QR Onboarding | tenant-safe QR/session state + TEST QR proof |
| OW-5 | Signed OpenWA Webhook Intake | authenticity + replay/dedup |
| OW-6 | Unified Inbound Normalization | CRM/automation parity |
| OW-7 | OpenWA Outbound Text & Reply | idempotent send/reconcile |
| OW-8 | Media | controlled media ingestion/send |
| OW-9 | Ack, Status & Reconciliation | provider status parity |
| OW-10 | Safety & Anti-Abuse Guardrails | bounded unofficial transport |
| OW-11 | Agents, Automations & Broadcast Routing | caller neutrality |
| OW-12 | Live TEST Acceptance | real linked-device proof |
| OW-13 | Bounded Pilot | operational evidence |
| OW-14 | Production Rollout | explicit release decision |

## Mandatory invariants
1. Every provider/session lookup is tenant/account scoped.
2. No plaintext provider credentials in DB/log/browser.
3. QR material is admin-only, short-lived and never persisted.
4. Meta behavior must remain green after every phase.
5. No blind resend after ambiguous provider timeout.
6. Applied migrations are never edited; schema changes are additive.
7. OpenWA runtime outbound routing remains disabled until OW-7.
8. NOTE-001 must be reviewed before any production-ready/GA claim.

## Definition of Done levels
`implementation complete` means code/schema/tests for the phase exist.
`TEST verified` means the phase's required TEST environment evidence passes.
`live acceptance complete` means required real-provider scenarios have been executed and recorded.
`production ready` requires later rollout gates, operational evidence, NOTE-001 review and explicit release approval.
