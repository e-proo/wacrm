# OW-0 — Completed Audit & Provider Contract Freeze

Status: **COMPLETE** — evidence/planning only. No runtime behavior changed by OW-0.

Audit baseline code commit: `e05792f90775fa01e17b20614e1a98511017d002`.
Planning HEAD inspected before audit: `c40820639eae0676f2baba2d05bdba858ac3b115`.
Linear: `SOF-28`.

## 1. Executive conclusion

WACRM already has a useful business/transport separation direction, but WhatsApp execution is still Meta-specific in multiple independent outbound paths. The OpenWA integration MUST therefore introduce a provider contract below business intent and above provider APIs, then migrate existing Meta callers behind it without changing their business persistence/idempotency semantics.

OW-0 freezes these rules:
1. `meta-api.ts` remains the Meta Graph adapter implementation; it is not replaced.
2. OpenWA is an additional provider (`openwa`), not a replacement for Meta Cloud (`meta_cloud`).
3. `whatsapp-web.js` / `baileys` are OpenWA engine metadata, not top-level WACRM providers.
4. WACRM remains source of truth for contacts, conversations, messages, broadcasts, automations, agents, tasks/outreach and audit.
5. OpenWA owns linked-device/session transport mechanics only.
6. Existing Meta identifiers (`messages.message_id`, broadcast `wamid`) stay backward compatible during additive migration.
7. Provider credentials, QR/session secrets, engine-specific types and Meta-only payload shapes stay behind adapter boundaries.
8. Every implementation phase must pass a fresh Meta regression gate before progressing.

## 2. Current outbound surface map

### Dashboard/manual + public API
`src/lib/whatsapp/send-message.ts` is the shared send core used by dashboard/public API adapters. It currently owns account-scoped contact/config resolution, Meta token decryption, Meta phone normalization/variant retry, reply lookup through `messages.message_id`, direct Meta text/template/media/interactive dispatch, message persistence, conversation updates and Flow pause on human intervention.

Known adapters:
- `src/app/api/whatsapp/send/route.ts`
- `src/app/api/v1/messages/route.ts`

### Automation engine
`src/lib/automations/meta-send.ts` is a separate Meta-coupled path. It owns account-scoped contact/config lookup, token decryption, phone retry, send/persist behavior and business-notification idempotency. Some interactive behavior delegates to the Flow sender.

### Flow engine
`src/lib/flows/meta-send.ts` is another direct Meta path containing text/media/interactive sends, account-scoped config, phone retry, message persistence and conversation updates. Existing source comments already identify shared extraction as a future direction.

### Broadcast engine
`src/lib/whatsapp/broadcast-core.ts` directly imports Meta transport functions. It validates account ownership, reserves recipients atomically with `reserve_broadcast_recipient`, rate-limits, sends template/text, stores provider IDs as `wamid`, classifies failures and finalizes counters/status.

`src/lib/whatsapp/broadcast-resume.ts` provides recovery/orchestration around the same core and preserves reservation/idempotency semantics.

Broadcast ownership remains in WACRM. OpenWA executes individual sends only; it does not replace WACRM campaign state, recipient reservation, pause/resume or audit.

Current shape:
```text
Dashboard/Public API -> whatsapp/send-message.ts ---------> meta-api.ts
Automation Engine    -> automations/meta-send.ts ---------> meta-api.ts / flows/meta-send.ts
Flow Engine          -> flows/meta-send.ts ---------------> meta-api.ts
Broadcast Engine     -> broadcast-core.ts ----------------> meta-api.ts
```

Target:
```text
Business callers
      |
WhatsAppTransport / Provider Router
      |
      +-- MetaWhatsAppTransport -> meta-api.ts
      +-- OpenWATransport ------> OpenWA REST
```

OW-2 is not complete until all four caller families are behind the provider boundary.

## 3. Inbound/status pipeline audit

`src/app/api/whatsapp/webhook/route.ts` is the current Meta webhook + business-dispatch pipeline. It coordinates:
- Meta verification/authenticity
- `phone_number_id` / account config resolution
- inbound message extraction
- contact/conversation resolution
- message deduplication/persistence
- inbound media mirroring
- reply/context and reaction handling
- delivery/read/failure status handling
- broadcast recipient reconciliation/counters
- Flow dispatch/resume
- Automation dispatch
- AI/agent-related dispatch where enabled
- service-platform/task/outreach processing present in the webhook pipeline
- external event/webhook fan-out
- template lifecycle updates

OW-6 must not clone this business pipeline. Frozen design:
```text
Meta webhook ----> MetaWebhookAdapter ----┐
                                          v
                                  UnifiedInboundEvent
                                          |
OpenWA webhook --> OpenWAWebhookAdapter --┘
                                          |
                             Existing WACRM business pipeline
```

Adapters own provider authenticity/raw parsing/provider IDs. Shared WACRM owns tenant resolution, contacts/conversations, persistence, automation/agent/flow/task dispatch and audit.

## 4. Schema / migration / RLS audit

Relevant evolution:
- `001_initial_schema.sql`: original WhatsApp/config/contact/conversation/message/broadcast schema.
- `003_broadcast_recipient_wamid.sql`: Meta-shaped broadcast identity (`wamid`) and recipient reliability behavior.
- `009_message_actions.sql`: message action/reply/reaction fields tied to provider message identity.
- `017_account_sharing.sql`: account membership/role model and account-scoped RLS evolution. OW-1 must build on this; never reintroduce user-scoped connection ownership.
- `037_webhook_broadcast_reliability.sql`: webhook/broadcast reliability.
- `038_broadcast_resume.sql`: resume/recovery behavior.
- `039_inbound_media_mirror.sql`: inbound media mirroring.

The current branch migration tree reaches `079_service_platform_phase6_transport.sql`. OW-1 therefore uses a new additive migration after the current sequence. No historical migration is edited.

Frozen OW-1 direction:
```text
whatsapp_connections
- id
- account_id
- provider: meta_cloud | openwa
- display/phone identity
- lifecycle status
- provider external/session identity
- provider metadata (non-secret extras)
- timestamps
```

Provider-neutral message identity is additive:
```text
connection_id
provider
provider_message_id
```

Compatibility rules:
- keep `messages.message_id` working while readers/writers migrate
- keep broadcast `wamid` working while readers/writers migrate
- scope uniqueness by provider/connection where appropriate
- deterministic/idempotent backfill only
- account-scoped RLS
- service-role webhook lookup must resolve an explicit connection/account
- credentials encrypted/server-only

## 5. Security and tenant boundary

Every provider action resolves:
```text
account_id + connection_id + provider
```

OpenWA additionally maps provider session/instance identity to that connection.

Mandatory rules:
- cross-account connection access denied
- QR/session/connection mutation restricted to a sufficiently privileged existing account role
- no plaintext provider credentials in browser state, logs or client-readable DB responses
- QR payload short-lived/admin-only and excluded from analytics/logging
- webhook signature verification before business processing
- replay/dedup protection
- unknown OpenWA session rejected, never guessed by phone number alone
- restricted/logged-out connection blocks outbound sends

Existing project-wide Supabase debt in `NOTE-001` remains a separate production-readiness gate; OW-0 does not claim it is resolved.

## 6. Frozen provider contract

Exact file names are OW-2 implementation detail; semantics are frozen.

```ts
type WhatsAppProvider = 'meta_cloud' | 'openwa'
type OpenWAEngine = 'whatsapp-web.js' | 'baileys'

interface WhatsAppSendRequest {
  accountId: string
  connectionId: string
  recipient: string
  content: WhatsAppContent
  replyToProviderMessageId?: string
  idempotencyKey?: string
}

interface WhatsAppSendResult {
  provider: WhatsAppProvider
  connectionId: string
  providerMessageId: string
  acceptedAt?: string
  providerMetadata?: Record<string, unknown>
}
```

Business callers never branch on OpenWA engine.

Normalized transport failures:
- `unsupported_capability`
- `invalid_request`
- `authentication_or_configuration`
- `recipient_invalid_or_unreachable`
- `rate_limited`
- `retryable_provider_failure`
- `connection_restricted`
- `permanent_provider_failure`
- `ambiguous_outcome`

Capability contract:
```ts
interface WhatsAppCapabilities {
  text: boolean
  media: boolean
  replies: boolean
  reactions: boolean
  interactive: boolean
  officialTemplates: boolean
  deliveryStatus: boolean
  readStatus: boolean
  qrAuthentication: boolean
  linkedDeviceSession: boolean
}
```

Groups/channels/calls/presence/labels/catalog remain deferred in V1 even when a provider can support them.

## 7. Validated OpenWA baseline

OW-0 validated the selected gateway as `rmyndharis/OpenWA`, disambiguating it from the similarly named `open-wa/wa-automate-nodejs` library.

Confirmed from the selected gateway documentation/source:
- multi-session REST + webhook gateway
- engines include `whatsapp-web.js` and `baileys`
- `ENGINE_TYPE` config means engine placement is OpenWA infrastructure metadata, not a per-message business choice
- session create/start/stop/logout/status/QR operations
- text and media send endpoint families
- message/session/status webhook event families
- webhook signing via `X-OpenWA-Signature` using HMAC-SHA256 over raw body when a webhook secret is configured
- webhook retry/dead-letter behavior
- send idempotency support; WACRM still keeps its own business idempotency
- health/readiness endpoints

Implementation must pin an OpenWA version/image and rerun contract tests before deployment.

Capability matrix:
| Capability | Meta Cloud | OpenWA target | WACRM treatment |
|---|---|---|---|
| text | yes | yes | common |
| image/video/audio/document | yes | yes | common MVP |
| reply/context | yes | yes | common MVP |
| reactions | current support | provider capability | capability-gated |
| official Meta template | yes | no equivalent | Meta-only policy capability |
| interactive buttons/lists | current Meta path | version/provider dependent | capability-gated; no assumed parity |
| delivery/read status | yes | event support | normalized status |
| QR authentication | no | yes | OpenWA-only connection capability |
| linked-device lifecycle | no | yes | OpenWA-only connection capability |
| groups/channels/calls/presence | not MVP | may exist | deferred |

## 8. Meta-only semantics behind adapter

These remain adapter-owned:
- Graph API URL/version
- `phone_number_id` / WABA mechanics
- access token format
- Meta template payload construction
- customer-service-window/template policy mechanics
- `wamid` naming
- Meta error parsing
- Meta phone-variant workaround
- Meta media/resumable upload mechanics
- Meta webhook payload/signature shape

## 9. Idempotency/reconciliation freeze

Manual/public sends preserve current persistence semantics during extraction.

Automation/agent/business notifications preserve existing local-first/business idempotency keys. Provider idempotency is defense in depth, not a replacement.

Broadcast preserves `reserve_broadcast_recipient`, attempt accounting, recovery/resume and finalization.

Inbound events use provider-scoped identity such as:
```text
(provider, connection_id, provider_event_id)
```

OpenWA webhook-delivery retry and WACRM business-processing retry are independent retry domains.

A timeout after possible provider acceptance becomes `ambiguous_outcome`; do not blindly resend when reconciliation is possible.

## 10. Meta regression baseline

Repository CI runs:
- `npm ci`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`

The last runtime/code baseline before OpenWA planning is `e05792f90775fa01e17b20614e1a98511017d002`. Its branch CI completed successfully across lint/typecheck/test/build. Comparing that baseline through OW-0 planning HEAD shows documentation-only additions under `plans/WhatsApp Multi-Provider OpenWA Integration/`; no runtime/source/migration/package behavior changed.

OW-0 therefore records successful `e05792...` CI as its Meta regression baseline. OW-1 and every runtime/schema phase require fresh CI/TEST evidence on their own implementation commits.

Focused regression families frozen for preservation/extension:
- `src/lib/whatsapp/meta-api.test.ts`
- `src/lib/whatsapp/meta-api.media.test.ts`
- `src/lib/whatsapp/meta-api.resumable.test.ts`
- `src/lib/whatsapp/interactive.test.ts`
- `src/lib/whatsapp/broadcast-core.test.ts`
- `src/lib/whatsapp/broadcast-resume.test.ts`
- `src/lib/whatsapp/mirror-inbound-media.test.ts`
- `src/lib/whatsapp/encryption.test.ts`
- Automation runner/idempotency suites
- Flow runner/resume suites
- webhook/status/broadcast integration coverage as OW-2/OW-6 touch those boundaries

Full CI remains mandatory; focused tests are not a substitute.

## 11. Extraction order frozen by OW-0

1. OW-1: additive provider-neutral connection/message identity schema + RLS.
2. OW-2: provider contract/router + Meta adapter with no behavior change.
3. Migrate manual/public send and prove parity.
4. Migrate Automation/agent/business sends and prove idempotency parity.
5. Migrate Flow sends and prove resume/persistence parity.
6. Migrate Broadcast provider call while preserving reservation/recovery/finalization.
7. Only then allow OpenWA selection for production business sends.
8. OW-6 normalizes OpenWA inbound events into the shared WACRM business pipeline.

## 12. OW-0 Definition of Done

- [x] current branch HEAD reverified before audit
- [x] major outbound call-site families mapped
- [x] manual/public send path mapped
- [x] Automation send path mapped
- [x] Flow send path mapped
- [x] Broadcast transport/idempotency/recovery path mapped
- [x] inbound/status/business dispatch responsibilities mapped
- [x] migration/RLS evolution audited
- [x] latest migration sequence identified (`079_service_platform_phase6_transport.sql`)
- [x] security/tenant boundary frozen
- [x] provider contract semantics frozen
- [x] normalized error model frozen
- [x] capability matrix validated against selected OpenWA gateway
- [x] selected OpenWA repository disambiguated
- [x] OpenWA HMAC/retry/idempotency/session/health baseline validated
- [x] Meta-only semantics assigned to adapter boundary
- [x] focused regression families frozen
- [x] successful Meta regression baseline evidence recorded
- [x] runtime comparison confirms OW-0 changes are documentation-only
- [x] OW-1/OW-2 implementation order and gates frozen

## 13. Exit decision

**PASS. OW-0 is complete and may be closed.**

This is architecture/audit readiness only. It does not mean OpenWA implementation, TEST live acceptance, bounded pilot or production readiness is complete.

Next executable phase: **OW-1 — Provider-neutral connection/data model + RLS**, using a new additive migration after `079_service_platform_phase6_transport.sql`, followed by clean migration verification, cross-tenant tests and a fresh Meta regression gate.