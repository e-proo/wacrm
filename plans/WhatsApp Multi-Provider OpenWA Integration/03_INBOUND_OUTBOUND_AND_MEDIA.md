# OW-5 .. OW-9 — Webhooks, Inbound, Outbound, Media, Reconciliation

## OW-5 — Signed OpenWA Webhook Intake
Create a dedicated OpenWA webhook endpoint; do not overload Meta signature/verification semantics.

Required sequence:
1. read exact raw body
2. verify OpenWA signature/HMAC according to pinned deployed version
3. validate timestamp/replay protection if available/defined
4. resolve provider session/connection
5. enforce known active account-scoped mapping
6. reserve/deduplicate provider event identity
7. acknowledge quickly
8. perform durable/runtime-safe post-ack processing

Tests: valid/invalid signature, replay, malformed JSON, unknown session, tenant mismatch, duplicate event, provider retry, processing failure after ack.

Meta regression: existing `src/app/api/whatsapp/webhook/route.ts` verification and processing remain unchanged in behavior.

---

## OW-6 — Unified Inbound Normalization

### Goal
Converge Meta and OpenWA inbound messages into one internal model before CRM/business fan-out.

Normalized event must cover at least:
- provider + connection
- provider event/message ID
- sender/recipient provider identity
- timestamp
- text/media/reply/reaction where supported
- provider metadata needed for reconciliation only

Reuse current WACRM behavior after normalization: contact dedupe/resolution, conversation reopen/find-create, message persistence, media mirror, automations, Flows, AI auto reply/multi-agent routing, task reply correlation, and external webhook dispatch.

Do not duplicate the long Meta webhook business fan-out into a second OpenWA-only implementation. Extract/share normalized processing carefully, with Meta regression tests proving equivalent behavior.

Tests: same logical inbound text through Meta fixture and OpenWA fixture yields equivalent WACRM contact/conversation/message/business dispatch semantics; duplicate OpenWA event yields one message/fan-out.

---

## OW-7 — OpenWA Outbound Text & Reply

### Goal
Enable provider routing through the shared outbound core for text/reply.

Rules:
- caller chooses WACRM connection, not OpenWA engine.
- WACRM generates stable send idempotency identity before provider call.
- provider result maps to normalized `provider_message_id`.
- ambiguous timeout after possible provider acceptance must enter reconciliation, not blind duplicate retry.
- reply target must belong to same WACRM conversation/connection and map to provider-native message identity.
- OpenWA template policy must not pretend to be Meta approved-template policy.

Tests: text, reply, retryable error, permanent error, restriction, timeout/ambiguous, duplicate client retry, cross-tenant connection, disconnected connection.

---

## OW-8 — Media

### Goal
Support image/video/audio/document while retaining WACRM-controlled media ownership.

Inbound OpenWA media:
`provider event → authenticated provider fetch/descriptor → WACRM mirror/validation → controlled storage → message media reference`.

Reuse `src/lib/whatsapp/mirror-inbound-media.ts` where its contract is provider-neutral enough; otherwise refactor it into provider fetch + shared mirror stages rather than creating duplicate storage logic.

Outbound media uses the shared content model and provider adapter. Enforce size/MIME/caption limits per capability/provider policy.

Never persist raw base64 in `messages`; never log media credentials/signed URLs beyond safe operational metadata.

Tests: each MVP media kind, invalid MIME/size, provider download failure, storage failure, duplicate webhook, outbound timeout/reconciliation, Meta media regression.

---

## OW-9 — Ack, Delivery/Read Status & Reconciliation

### Goal
Normalize provider delivery lifecycle without assuming Meta status vocabulary is universal.

Required behavior:
- map provider status to WACRM message state
- ignore/regulate backward or duplicate transitions
- resolve by connection + provider message ID
- support ambiguous outbound reconciliation
- keep broadcast recipient/message state consistent
- record enough provider diagnostic metadata for operations without leaking secrets

Tests: sent/delivered/read/failed where available, duplicate status, out-of-order status, unknown message, wrong connection/tenant, ambiguous send eventually found/not found, provider outage.

### Exit gate for OW-5..OW-9
Each phase requires its focused suite plus Meta regression gate. OW-9 closes only when OpenWA text/reply/media/status flows are deterministic on TEST fixtures and no cross-tenant or duplicate-delivery defect remains.

### OW-9 closure evidence — 2026-10-26

- Implementation head before this documentation sync: `dec770736c0b6051e6f7295f34ba63711f055fd5`.
- Provider-neutral status lifecycle is implemented in `src/lib/whatsapp/status-lifecycle.ts` with account + connection + provider-message scoping, forward-only transitions, terminal failure handling, bounded diagnostics, and independent message/broadcast-recipient reconciliation.
- Meta status webhooks route through `src/lib/whatsapp/meta-status.ts` and the same lifecycle using the webhook `phone_number_id` → account → `meta_cloud` connection identity; the legacy unscoped `message_id` status updater was removed.
- OpenWA status/ack webhook events route through the signed/deduplicated OpenWA webhook intake into the same lifecycle.
- OpenWA ambiguous sends expose explicit idempotency-key reconciliation via `OpenWAClient.reconcileOutbound`; a timeout remains `ambiguous_outcome` and is not converted into a blind resend.
- Focused tests cover Meta/OpenWA vocabulary, sent/delivered/read/failed semantics, duplicate/backward transitions, unknown message, wrong tenant/connection, broadcast-only status correlation, secret redaction, reconciliation found/not-found, timeout and provider failure behavior.
- GitHub CI #903 / run `40379728734` completed successfully: Lint, Typecheck, Test, Build all green.
- Closure level: **implementation complete + CI/TEST-fixture verified**. Live OpenWA acceptance is not claimed; NOTE-007 remains the external live-session/QR acceptance dependency. Production readiness is not claimed while NOTE-001 remains open.
