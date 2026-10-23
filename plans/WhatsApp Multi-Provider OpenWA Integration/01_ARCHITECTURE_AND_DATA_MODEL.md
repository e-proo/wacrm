# OW-0 / OW-1 — Architecture, Contract Freeze, Data Model

Status: COMPLETE — OW-0 contract freeze and OW-1 provider-neutral data model are closed. OW-2 is the current phase.

## OW-0 — Baseline & Contract Freeze

### Purpose
Turn the current Meta-specific implementation into a documented provider contract without changing runtime behavior.

### Existing surfaces inventoried
- `src/lib/whatsapp/send-message.ts`: shared outbound core; loads `whatsapp_config`, decrypts Meta token, resolves Meta reply IDs, and calls Meta functions.
- `src/lib/whatsapp/meta-api.ts`: Meta Graph transport implementation.
- `src/app/api/whatsapp/send/route.ts`: authenticated dashboard adapter.
- `src/app/api/v1/messages/route.ts`: public API caller of the shared send core.
- `src/app/api/whatsapp/webhook/route.ts`: Meta inbound/status/template lifecycle path.
- `src/lib/automations/meta-send.ts`: direct Meta automation send surface.
- `src/lib/flows/meta-send.ts`: direct Meta Flow transport surface.
- broadcast core/resume code under `src/lib/whatsapp` and API routes under `src/app/api/whatsapp/broadcast`.
- `docs/architecture/messaging-business-events.md`: transport separation rules.

### OW-0 result
The provider contract, capability boundary, Meta-only semantics and current caller inventory were frozen without changing runtime behavior. OW-0 was closed before OW-1 implementation began.

---

## OW-1 — Provider-Neutral Data Model

### Final implementation
OW-1 was implemented additively; no applied migration was edited.

Primary migration:
- `supabase/migrations/143_whatsapp_provider_neutral_connections.sql`

Follow-up privilege migration discovered by clean CI replay:
- `supabase/migrations/144_whatsapp_connections_authenticated_grants.sql`

Permanent verification:
- `supabase/ci/whatsapp-provider-neutral-connections-smoke.sql`
- wired into `.github/workflows/migrations.yml`

### Final model
`public.whatsapp_connections` represents account-scoped WhatsApp connections for both `meta_cloud` and `openwa`, including lifecycle state and explicit OpenWA session/instance/engine routing metadata. Existing `whatsapp_config` remains intact for Meta compatibility and secrets were not copied into provider metadata.

Provider-neutral message identity was added additively to `messages` and `broadcast_recipients`:
- `connection_id`
- `provider`
- `provider_message_id`

Legacy `messages.message_id` and broadcast Meta message identity remain supported during the compatibility transition.

### RLS/security result
- RLS is enabled on `whatsapp_connections`.
- Account membership scopes reads.
- Connection mutation is restricted by the existing account-role model.
- `authenticated` receives the table privileges required for PostgreSQL to reach the RLS authorization layer; the grants do not replace or bypass RLS.
- Cross-account access denial was verified on TEST.
- Forbidden credential/secret keys were not copied into `provider_metadata`.
- Service-role/provider resolution remains required to be explicitly account/connection scoped in later runtime phases.

### Backfill/compatibility result
- Existing Meta configuration was deterministically mapped to provider-neutral Meta connection identity.
- Existing legacy message IDs were mapped to provider-neutral identity without removing legacy fields.
- Backfill behavior is deterministic/idempotent for the intended migration path.
- Existing Meta runtime routing was not switched to OpenWA in OW-1.

### Verification evidence
Verified implementation HEAD before documentation update: `31fa9f998099733cd3788c85f151c14444d1eb3c`.

TEST evidence:
- provider-neutral schema present
- Meta connection backfill verified
- provider-neutral legacy message backfill verified
- RLS enabled and policies verified
- owner/admin mutation behavior verified
- viewer/agent mutation denial verified where applicable
- synthetic outsider cross-tenant SELECT isolation verified
- credential non-exposure check passed
- migration 144 applied to TEST only to supply required authenticated table grants

GitHub evidence:
- Migrations run `40012212695`: SUCCESS
  - clean database startup
  - replay every migration from scratch
  - resulting schema verification
  - OW-1 provider-neutral WhatsApp schema/RLS smoke
  - remaining migration smoke suite
- CI run `40012212709` / #781: SUCCESS
  - lint
  - typecheck
  - tests
  - build

Linear evidence:
- `SOF-29 — OW-1 — Implement provider-neutral WhatsApp connection data model and tenant RLS`: Done.

### Exit gate
OW-1 is **COMPLETE at implementation complete + TEST verified + CI verified**.

This closure does not assert `live acceptance complete` or `production ready`. Project-wide security debt tracked by `PROJECT_NOTES.md` NOTE-001 remains a separate production-readiness dependency.

## Handoff to OW-2
The next phase is `OW-2 — Meta Adapter Extraction`. It must preserve the now-verified OW-1 schema/RLS baseline and extract Meta-specific transport behavior behind the provider-neutral boundary without changing observable Meta behavior. The Meta regression gate remains mandatory before OW-2 can close.
