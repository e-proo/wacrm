# OW-2 / OW-3 / OW-4 — Transport Foundation and OpenWA Sessions

## OW-2 — Extract Meta Behind Provider Boundary

### Goal
Introduce the provider-neutral transport boundary while preserving Meta behavior byte-for-byte where practical.

### Main affected surfaces
- `src/lib/whatsapp/send-message.ts`
- `src/lib/whatsapp/meta-api.ts`
- `src/lib/whatsapp/interactive.ts`
- template helpers under `src/lib/whatsapp`
- dashboard/public message routes that call the shared send core
- automation/broadcast callers discovered in OW-0

### Implementation direction
Create a provider contract/resolver in the existing WhatsApp domain rather than a parallel messaging system. Wrap current Meta calls in a Meta adapter. Keep Meta-only validation in Meta capability/policy paths; generic validation stays in shared core.

`sendMessageToConversation` should evolve from "load one Meta config and call Graph" to "resolve account connection, resolve provider adapter, send normalized request, persist normalized result" while preserving current auth, conversation/contact validation, Flow pause behavior and API response compatibility.

### Meta regression gate
All existing send types, reply context, phone normalization/retry, token encryption upgrade, templates, interactive payloads, media, broadcasts, automations, public API, and inbound Meta webhook/status behavior must remain green.

---

## OW-3 — OpenWA REST Client & Credential Boundary

### Goal
Add a server-only OpenWA client with no user-visible feature yet.

### New code direction
Prefer a focused provider directory under the existing WhatsApp domain, for example `src/lib/whatsapp/providers/openwa/*`, after OW-0 confirms naming does not duplicate an existing abstraction.

Client responsibilities:
- authenticated REST calls
- strict timeouts
- typed response/error mapping
- request correlation/idempotency headers where OpenWA supports them
- session operations
- send operations required by MVP
- health/status lookup
- no business rules

### Security
- OpenWA base URLs must be allowlisted/configured server-side; prevent arbitrary SSRF destinations.
- credentials encrypted or secret-managed; never returned to browser/logged.
- prefer session-scoped credentials where deployment supports them; central admin credentials have a larger blast radius and require stronger isolation.
- redact request/response secrets and QR material.

### Tests
HTTP mocking for success, timeout, 4xx, 5xx, malformed payload, restriction/auth failure, idempotency propagation, redaction and SSRF/URL validation.

### Exit gate
Client contract green with no runtime routing to OpenWA; Meta regression green.

---

## OW-4 — Session Lifecycle & QR Onboarding

### Goal
Allow an authorized WACRM admin to create and operate an OpenWA connection without leaving WACRM.

### State model
Minimum normalized states:
`creating`, `waiting_qr`, `authenticating`, `connected`, `ready`, `disconnected`, `reconnecting`, `restricted`, `logged_out`, `failed`.

### API/UI direction
Add provider-neutral connection management endpoints/UI rather than exposing OpenWA dashboard. Exact paths are chosen after inspecting current WhatsApp settings pages and config APIs.

Flow:
1. admin chooses `WhatsApp Web` provider
2. WACRM creates provider-neutral connection row
3. server selects/configures OpenWA instance
4. OpenWA session created/started
5. short-lived QR is returned only to authorized admin UI
6. webhook/polling updates normalized connection state
7. ready state enables bounded sending

### QR security
- admin-only
- short TTL
- never persist QR in analytics/logs/history
- no public caching
- invalidate on session transition/logout
- cross-tenant QR fetch must be impossible

### Engine placement
WACRM records OpenWA as provider. `whatsapp-web.js`/`baileys` is instance/session metadata. If OpenWA engine selection is deployment-level, operate separate instance pools and store placement on the connection; do not leak engine branching into business callers.

### Tests
role/tenant access, QR expiry, unknown session, duplicate create, reconnect, logout, restriction transition, stale webhook/state transition, OpenWA outage, Meta connection unaffected.

### Exit gate
TEST can create a non-production OpenWA session and safely display QR; no outbound production routing yet; Meta regression green.
