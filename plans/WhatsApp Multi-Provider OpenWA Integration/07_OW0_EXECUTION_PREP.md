# OW-0 — Execution Preparation & Audit Checklist

Status: READY FOR AUDIT — planning/evidence only. No runtime behavior change in OW-0.

Prepared against branch HEAD: `b82d8fbb1894fd92713575cf8cd4f57182dbf762`.

Linear: `SOF-28` — OW-0 Audit current WhatsApp surfaces and freeze provider contract.

## 1. Verified current architecture anchors

### Shared/manual outbound
`src/lib/whatsapp/send-message.ts` is the shared dashboard/public-API outbound core, but it is not provider-neutral internally. It currently:
- reads account-scoped `whatsapp_config`
- decrypts the Meta access token and self-heals legacy ciphertext
- resolves reply context through `messages.message_id`
- dispatches directly to Meta `sendTextMessage`, `sendTemplateMessage`, `sendMediaMessage`, `sendInteractiveButtons`, and `sendInteractiveList`
- applies Meta-specific phone sanitization/variant retry
- persists the returned Meta ID into `messages.message_id`
- updates conversation preview/timestamps and pauses active Flow runs on agent intervention

This file is therefore a major OW-2 extraction boundary, not the provider contract itself.

### Automation outbound
`src/lib/automations/meta-send.ts` is a second direct Meta transport surface. It owns account-scoped contact/config lookup, Meta phone rules, token decryption, persistence, and local-first idempotency behavior for AI/business notification sends. It also delegates interactive sends into the Flow Meta sender.

### Flow outbound
`src/lib/flows/meta-send.ts` is a third direct Meta transport surface. It contains text/media/interactive send behavior, account-scoped lookups, phone variant retry, persistence, and conversation updates. Existing comments already identify shared extraction as a future direction.

### Meta transport implementation
`src/lib/whatsapp/meta-api.ts` remains the low-level Meta Graph API implementation and must become/remain the Meta adapter implementation rather than being rewritten.

### WhatsApp API surface
Current `src/app/api/whatsapp` areas include `broadcast`, `config`, `media`, `react`, `send`, `templates`, and `webhook`. OW-0 must inspect each transport-sensitive route before contract freeze.

### Existing tests
The WhatsApp library already contains regression coverage including:
- `broadcast-core.test.ts`
- `broadcast-resume.test.ts`
- `encryption.test.ts`
- `interactive.test.ts`
- `meta-api.test.ts`
- `meta-api.media.test.ts`
- `meta-api.resumable.test.ts`
- `mirror-inbound-media.test.ts`

Automation and Flow suites also exist and must be included where transport behavior is touched.

## 2. Key finding to freeze before implementation

There is currently no single transport seam. At least three outbound implementations own overlapping Meta-specific responsibilities:

```text
Dashboard/Public API -> whatsapp/send-message.ts -> meta-api.ts
Automation Engine    -> automations/meta-send.ts -> meta-api.ts / flows/meta-send.ts
Flow Engine          -> flows/meta-send.ts       -> meta-api.ts
Broadcast            -> broadcast core/resume    -> inspect exact transport calls
```

OW-2 must not simply wrap `send-message.ts`; doing that would leave Automation/Flow/Broadcast on parallel Meta paths. The provider contract must be low enough to serve all business callers while preserving each caller's persistence/idempotency semantics during migration.

## 3. Audit work package

Before OW-0 closes, inspect and record:

### A. Outbound callers
- every import/call of Meta send functions
- dashboard send route
- public v1 message routes
- automation engine send paths
- Flow engine send paths
- broadcast initial-send/resume paths
- reactions and media routes if they perform provider calls
- AI Agent/task/outreach paths that reach any of the above

For each caller record:
`caller -> business intent -> DB lookup -> provider call -> persistence -> idempotency -> retry -> status handling`.

### B. Inbound/status paths
Inspect `src/app/api/whatsapp/webhook/route.ts` and map:
- webhook verification/authenticity
- account/config resolution
- inbound message parsing
- contact/conversation resolution
- message deduplication/persistence
- media mirroring
- reply/context mapping
- delivery/read/failure status updates
- broadcast recipient reconciliation
- Flow/Automation dispatch
- AI Agent dispatch
- task/outreach correlation
- external webhook fan-out
- template lifecycle updates

The target of OW-6 is to extract provider-normalized inbound events before shared business processing, not duplicate this pipeline for OpenWA.

### C. Schema/migrations
Inventory every migration touching:
- `whatsapp_config`
- `messages.message_id`
- `broadcast_recipients.wamid`
- contacts/conversations tenancy
- account migration/RLS
- AI/automation idempotency keys
- message reply/reaction/status fields

Do not choose the OW-1 migration number until this inventory confirms the latest sequence on current HEAD.

### D. CI/regression
Current package scripts include `lint`, `typecheck`, `test`, and `build`. OW-0 must freeze the exact focused test set plus branch-wide gates used before and after every provider refactor phase.

## 4. Draft provider contract requirements

The contract must support these normalized inputs without exposing Meta credentials or OpenWA engine details to business callers:

```ts
provider: 'meta_cloud' | 'openwa'
connectionId: string
recipient: provider-neutral recipient identity
content: text | media | interactive | template-capability request
replyToProviderMessageId?: string
idempotencyKey?: string
```

Normalized result:

```ts
provider
connectionId
providerMessageId
acceptedAt?
providerMetadata? // adapter-owned, non-secret
```

Normalized error classes must distinguish at least:
- invalid request / unsupported capability
- authentication/configuration
- recipient/address failure
- rate limit / retryable provider failure
- restriction/account state
- permanent provider failure
- ambiguous outcome requiring reconciliation

Exact TypeScript names are not frozen until the complete caller audit is finished.

## 5. Capability matrix to finalize in OW-0

| Capability | Meta Cloud | OpenWA target | Contract treatment |
|---|---|---|---|
| text | yes | required | common |
| image/video/audio/document | yes | required | common |
| reply/context | yes | required | common |
| official Meta template | yes | no equivalent | provider capability/policy |
| interactive buttons/lists | yes | verify exact OpenWA parity | capability-gated |
| delivery/read status | yes | required where emitted | normalized status |
| QR authentication | no | yes | connection capability |
| linked-device session lifecycle | no | yes | OpenWA-only connection capability |
| groups/channels/calls/presence | not MVP | deferred | explicitly unsupported in MVP |

OpenWA feature claims must be revalidated against the exact OpenWA version/docs selected for deployment before OW-3 implementation.

## 6. Meta semantics that must remain adapter-owned

- Graph API endpoint/version details
- `phone_number_id` and WABA semantics
- access token format/decryption use
- Meta approved template payload construction
- 24-hour/customer-service policy behavior
- Meta `wamid`
- Meta-specific error parsing
- recipient phone variant workaround
- Meta media upload/resumable upload behavior
- webhook signature/payload shape specific to Meta

Business callers should not gain new dependencies on these concepts.

## 7. Proposed extraction order after OW-0

1. OW-1 adds provider-neutral connection/message identity schema additively while keeping Meta compatibility.
2. OW-2 introduces the transport contract and Meta adapter.
3. Migrate one caller family at a time behind the Meta adapter, proving behavior parity after each move.
4. Only after all current Meta caller families are covered should OpenWA become selectable for production business sends.

This ordering prevents a partial abstraction where manual sends are multi-provider but automations/flows/broadcasts silently remain Meta-only.

## 8. OW-0 regression baseline commands

Minimum repository gates to record:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Focused tests must include all existing WhatsApp Meta API, inbound media, interactive, broadcast, automation and Flow transport-sensitive suites discovered by the final inventory. Migration verification is mandatory starting OW-1 and whenever schema changes.

## 9. OW-0 exit checklist

- [x] current branch HEAD reverified before preparation
- [x] shared/manual Meta coupling confirmed
- [x] automation Meta coupling confirmed
- [x] Flow Meta coupling confirmed
- [x] current WhatsApp API areas inventoried at directory level
- [x] existing WhatsApp test family inventoried at directory level
- [ ] exact outbound call-site inventory complete
- [ ] exact inbound/status dispatch map complete
- [ ] broadcast transport/idempotency map complete
- [ ] migration/RLS inventory complete
- [ ] focused regression test list frozen
- [ ] provider contract TypeScript shape frozen
- [ ] capability matrix validated against selected OpenWA release/docs
- [ ] Meta regression baseline evidence recorded

OW-0 remains open until every unchecked item has evidence. No runtime implementation should be started merely because this preparation document exists.
