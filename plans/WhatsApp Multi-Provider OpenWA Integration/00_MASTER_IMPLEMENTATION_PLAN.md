# WACRM — WhatsApp Multi-Provider + OpenWA Integration

Status: EXECUTION IN PROGRESS — OW-0, OW-1 and OW-2 closed; OW-3 is the current engineering phase.

## Objective
Add OpenWA as an optional self-hosted WhatsApp Web transport while preserving Meta WhatsApp Cloud API as the official/default production transport. WACRM remains the source of truth for contacts, conversations, messages, campaigns, automations, agents, business policy, audit, and idempotency.

## Source-of-truth baseline
- Repository: `e-proo/wacrm`
- Branch: `refactor/service-platform-v2`
- Planning baseline HEAD at plan creation: `e05792f90775fa01e17b20614e1a98511017d002`
- OW-1 verified implementation HEAD: `31fa9f998099733cd3788c85f151c14444d1eb3c`
- OW-2 verified implementation HEAD: `431eed953c06c2c55f4bb80b6445d16464682e67`
- OW-2 closure CI: GitHub CI #799 / run `40025933870` = `completed/success`
- Current execution phase: `OW-3 — OpenWA Client & Credential Boundary`
- Existing outbound core: `src/lib/whatsapp/send-message.ts`
- Existing low-level Meta client: `src/lib/whatsapp/meta-api.ts`
- Provider-neutral transport contract: `src/lib/whatsapp/transport/types.ts`
- Meta transport adapter/resolver: `src/lib/whatsapp/transport/meta-adapter.ts`
- Existing inbound Meta webhook: `src/app/api/whatsapp/webhook/route.ts`
- Existing inbound media mirror: `src/lib/whatsapp/mirror-inbound-media.ts`
- Existing messaging architecture: `docs/architecture/messaging-business-events.md`
- Project-wide Supabase security debt remains tracked by `PROJECT_NOTES.md` NOTE-001 and is a production-readiness dependency, not something this integration may silently weaken or bypass.

## Verified execution status
| Phase | Status | Evidence level |
|---|---|---|
| OW-0 | COMPLETE | contract/baseline freeze; no runtime behavior change |
| OW-1 | COMPLETE | implementation complete + TEST verified + CI verified |
| OW-2 | COMPLETE | implementation complete + CI verified; zero-regression Meta extraction gate passed |
| OW-3 | CURRENT / READY TO EXECUTE | OpenWA server-side client + credential/security contract; no runtime routing yet |
| OW-4..OW-14 | NOT STARTED | gated by preceding phases |

### OW-2 closure evidence
- Final implementation HEAD: `431eed953c06c2c55f4bb80b6445d16464682e67`.
- GitHub CI #799 / run `40025933870`: `completed/success`, covering branch lint, typecheck, tests and build.
- No schema migration was introduced by OW-2; OW-1 remains the provider-neutral schema baseline.
- `src/lib/whatsapp/meta-api.ts` remains the low-level Meta Graph implementation.
- `src/lib/whatsapp/transport/types.ts` defines the provider-neutral request/result/error contract.
- `src/lib/whatsapp/transport/meta-adapter.ts` owns Meta-specific resolution, credential access, phone-variant behavior and Graph dispatch.
- Manual/dashboard/public sends, automation/agent/business sends, Flow sends, broadcast initial delivery and broadcast resume are routed through the Meta transport boundary.
- Existing WACRM idempotency/reservation/recovery/finalization ownership is preserved; OpenWA runtime routing is not enabled.
- New Meta sends persist provider-neutral identity while retaining legacy Meta message identifiers for compatibility.
- Linear closure issue: `SOF-30`.

OW-2 closure is not live OpenWA acceptance and does not mean production/GA readiness. NOTE-001 and OW-3..OW-14 remain separate gates.

## Architectural decision
WACRM exposes a provider-neutral WhatsApp transport boundary. Provider values are initially `meta_cloud` and `openwa`. OpenWA engine (`whatsapp-web.js` or `baileys`) is provider-internal metadata, not a top-level WACRM transport.

Target flow:

```text
WACRM business/agent/automation caller
             |
             v
      WhatsApp transport boundary
        /                 \
Meta Cloud adapter      OpenWA adapter
        |                  |
 Meta Graph API        OpenWA REST
                           |
                    wwebjs / Baileys
```

Inbound providers converge into one normalized WACRM message/event path before CRM, automation, Flow, Agent Runtime, task correlation, and external webhook fan-out.

## Non-goals
- Do not replace Meta Cloud API.
- Do not copy OpenWA internals into the Next.js application.
- Do not embed Chromium/Baileys lifecycle into WACRM web processes.
- Do not move campaign/broadcast ownership, AI business logic, automations, or CRM truth into OpenWA.
- Do not expose OpenWA dashboard directly to WACRM customers.
- Do not add groups/channels/calls/catalog/presence to the first production scope.

## Phase map

| Phase | Name | Primary gate |
|---|---|---|
| OW-0 | Baseline & Contract Freeze | architecture/compatibility |
| OW-1 | Provider-Neutral Data Model | migrations + RLS |
| OW-2 | Meta Adapter Extraction | zero Meta behavior regression |
| OW-3 | OpenWA Client & Credential Boundary | client/security contract |
| OW-4 | Session Lifecycle & QR Onboarding | tenant-safe QR/session state |
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

## Mandatory Meta regression gate
Every implementation phase from OW-1 onward must prove that existing Meta behavior remains green before the phase can close. At minimum, run the relevant existing Meta/WhatsApp unit and route tests plus branch-wide lint/typecheck/test/build and migration verification when schema changes. A phase that adds OpenWA behavior but breaks Meta is FAILED, not partially complete.

## Cross-cutting invariants
1. Tenant isolation: every connection/session/provider lookup is account-scoped; no cross-account send, QR, status, media, webhook, or credential access.
2. Secrets: no plaintext OpenWA or Meta credentials in logs/client payloads. Existing encrypted Meta token behavior remains intact.
3. Idempotency: provider webhook retries and WACRM business retries are separate retry domains and both must be safe.
4. Provider identity: do not treat Meta `wamid` as universal. Provider-neutral identity exists additively; preserve backward compatibility while callers migrate.
5. Rollback: schema changes are additive; applied migrations are never edited.
6. CRM ownership: provider contacts/chats are transport identities mapped into WACRM contacts/conversations; they are not the source of truth.
7. Async webhook processing: acknowledge quickly, then process through a runtime-safe mechanism; do not perform AI fan-out before acknowledgement.
8. OpenWA risk: WhatsApp Web automation is unofficial and must have explicit UI/ops warnings, rate controls, restriction handling, and bounded rollout.

## Data-model baseline after OW-1
OW-1 froze and verified the additive provider-neutral model:
- `whatsapp_connections`: account-scoped provider-neutral connection record supporting `meta_cloud` and `openwa`.
- Existing `whatsapp_config` remains compatible; credentials were not destructively moved.
- OpenWA session/instance/engine state has explicit provider-neutral connection fields where routing/search requires them.
- `messages` and `broadcast_recipients` have additive `provider`, `connection_id`, and `provider_message_id` identity while preserving legacy Meta IDs.
- RLS and authenticated table grants are both present; RLS remains the tenant/role authorization boundary.

## Initial MVP capability envelope
Required before live acceptance: session creation, QR, connection state/recovery, inbound/outbound text, replies, inbound/outbound image/video/audio/document, delivery/read status where provider supplies it, logout/disconnect, restriction detection, signed webhooks, deduplication, idempotent send semantics, and WACRM-owned safety limits.

Deferred: groups, channels, calls, presence, labels, catalogs, OpenWA automation/auto-reply/plugin systems.

## Test strategy
- Provider contract tests.
- Meta adapter regression tests.
- OpenWA client/adapter unit tests.
- Webhook signature, timestamp/replay, unknown-session, tenant mismatch, duplicate-event tests.
- Inbound normalization parity tests.
- Outbound idempotency and ambiguous-send reconciliation tests.
- Media boundary tests.
- Cross-tenant RLS/API tests.
- Restart/reconnect tests for WACRM and OpenWA.
- Real-number TEST acceptance with a dedicated/non-critical WhatsApp number.
- Bounded pilot with explicit stop conditions.

## Definition of Done levels
`implementation complete` means code/schema/tests for the phase exist.
`TEST verified` means CI/migrations and TEST environment evidence pass when the phase changes deployable TEST/schema behavior.
`live acceptance complete` means the required real-provider scenario has been executed and recorded.
`production ready` requires all preceding levels, bounded pilot evidence, operational rollback/monitoring, unresolved security debt review (including NOTE-001), and explicit release approval.

## Execution rule
Before implementing OW-3 or any later phase, re-read its detailed file, verify current branch HEAD and affected code/schema, then execute only that phase. Update the plan whenever current repository evidence changes the baseline.
