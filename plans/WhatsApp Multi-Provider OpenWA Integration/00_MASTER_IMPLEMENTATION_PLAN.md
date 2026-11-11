# WACRM — WhatsApp Multi-Provider + OpenWA Integration

Status: EXECUTION IN PROGRESS — OW-0..OW-11 implementation phases closed; OW-12 remains partial live acceptance In Progress; OW-13 preparation is In Progress from 2026-11-11 (SOF-42) but pilot execution (SOF-43) is blocked and not started; OW-14 not started. Historical OW-4 closure checkpoint 2026-11-07.

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
- OW-4 closure verified implementation merge HEAD: `c87fd13cf68df1cc6757fd910a7761e9110ff411` (PR #3; CI and clean replay passed).
- OW-4 current-HEAD GitHub CI: [run 42410328689](https://github.com/e-proo/wacrm/actions/runs/42410328689) = `completed/success` (lint, typecheck, OW-4/Meta gate, all tests, build).
- OW-4 current-HEAD GitHub Migrations: [run 42410328723](https://github.com/e-proo/wacrm/actions/runs/42410328723) = `completed/success` (full clean replay and OW-4 security smoke).
- Current execution phase: `OW-12 — Live TEST Acceptance` (partial; SOF-41). OW-4 SOF-33 closure gate passed; phase to be recorded Done in Linear.
- Project-wide Supabase security debt remains tracked by `PROJECT_NOTES.md` NOTE-001 and is a production-readiness dependency.

## Verified execution status
| Phase | Status | Evidence level |
|---|---|---|
| OW-0 | COMPLETE | contract/baseline freeze |
| OW-1 | COMPLETE | implementation complete + TEST verified + CI verified |
| OW-2 | COMPLETE | implementation complete + CI verified; Meta regression gate passed |
| OW-3 | COMPLETE | implementation complete + TEST migration/security evidence + CI verified |
| OW-4 | COMPLETE — implementation + live TEST QR/session + CI verified | [merge CI #42410328689](https://github.com/e-proo/wacrm/actions/runs/42410328689), [merge Migrations #42410328723](https://github.com/e-proo/wacrm/actions/runs/42410328723); add-on TEST migration 152 verified; not OW-12 full live acceptance |
| OW-5..OW-11 | IMPLEMENTATION ISSUES DONE | prior implementation + CI gates (SOF-34..SOF-40); not OW-12 live acceptance |
| OW-12 | LIVE TEST PARTIALLY VERIFIED | session/QR/ready, Webhook 202, inbound text, AI reply and read receipt verified; remaining acceptance matrix open |
| OW-13 | PREPARATION IN PROGRESS; PILOT NOT STARTED | Preparation SOF-42; pilot SOF-43 blocked by OW-12 live acceptance and approval |
| OW-14 | NOT STARTED | production decision requires pilot, security and ops evidence |

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

## OW-4 live TEST closure checkpoint — 2026-11-07

The original external provider prerequisite was **exercised successfully** on TEST: WACRM created an OpenWA session (HTTP 201), fetched a short-lived QR through an authenticated admin-only, account-scoped, no-store API (HTTP 200), and displayed the connection in `ready`. TEST now has two OpenWA `ready` connections plus a distinct Meta `connected` connection. The original deferral in NOTE-007 is resolved for this happy path.

OW-4 closure gate **PASSED on 2026-11-07**: verification [PR #3](https://github.com/e-proo/wacrm/pull/3) merged to the designated development branch at `c87fd13cf68df1cc6757fd910a7761e9110ff411`. On the exact merge commit, GitHub Actions [CI #42410328689](https://github.com/e-proo/wacrm/actions/runs/42410328689) was `completed/success` for lint/typecheck, focused OW-4 session/QR and Meta regression, complete tests and build; [Migrations #42410328723](https://github.com/e-proo/wacrm/actions/runs/42410328723) was `completed/success` for clean Supabase replay, OW-4 tenant/credential/RLS smoke and all existing smoke checks. Earlier PR-head green runs ([CI #42409821758](https://github.com/e-proo/wacrm/actions/runs/42409821758) and [Migrations #42409821723](https://github.com/e-proo/wacrm/actions/runs/42409821723)) corroborate, but the merge-HEAD runs are the closure evidence. Migration `152_openwa_service_role_credential_grants.sql` was applied to TEST, with service-role-only credential privileges and RLS verified; no Production changes. Closure level is **implementation complete + TEST session/QR verified + CI verified**; this is not general OW-12 live acceptance or production readiness.

OW-12 remains open: signed inbound was accepted (`202`), a prior `PGRST205` TEST schema gap was repaired by applying existing migrations `147` and `148`, and a provider-native `@lid` outbound misrouting defect was repaired at current implementation HEAD using additive migrations `150`/`151`. The new AI response reached `read` in TEST, while an older ambiguous `sending` row still requires safe reconciliation. The complete live media/reconnect/duplicate/automation/broadcast/tenant/Meta matrix is not yet passed. See [dated Linear evidence](https://linear.app/eproo/document/openwa-live-test-checkpoint-2026-11-07-ow-4-ow-12-1e473cda8576).

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

## OW-13 preparation checkpoint — 2026-11-11

- Verified pre-preparation HEAD `b6babdfe7931258c976318fc1adb0bc94ae4dc1c`: [CI 43094036951](https://github.com/e-proo/wacrm/actions/runs/43094036951) completed/success; it is not live pilot acceptance.
- New canonical bounded-pilot preparation and GO/NO-GO plan: [08_OW13_BOUNDED_PILOT_PREPARATION.md](08_OW13_BOUNDED_PILOT_PREPARATION.md).
- [SOF-42](https://linear.app/eproo/issue/SOF-42/ow-13-prep-prepare-bounded-openwa-pilot-controls-monitoring-and) prepares controls; [SOF-43](https://linear.app/eproo/issue/SOF-43/ow-13-execute-bounded-openwa-pilot-after-ow-12-live-acceptance-not) remains blocked by [SOF-41](https://linear.app/eproo/issue/SOF-41/ow-12-execute-live-openwa-test-acceptance) and SOF-42. No real cohort, Production enablement or outbound sends were authorized.
- Read-only TEST: five OpenWA ready connections, ten unresolved sending messages without provider-native IDs. They must not be resent or reclassified by inference.
- Missing server-enforced pilot cohort admission in the examined outbound boundary and unproven admin-operated emergency stop are pre-activation work, not accepted rollout features. NOTE-001 remains open before Production/GA.
