# OW-0 / OW-1 — Architecture, Contract Freeze, Data Model

## OW-0 — Baseline & Contract Freeze

### Purpose
Turn the current Meta-specific implementation into a documented provider contract without changing runtime behavior.

### Existing surfaces to inspect before implementation
- `src/lib/whatsapp/send-message.ts`: shared outbound core; currently loads `whatsapp_config`, decrypts Meta token, resolves Meta reply IDs, and calls Meta functions.
- `src/lib/whatsapp/meta-api.ts`: Meta Graph transport implementation.
- `src/app/api/whatsapp/send/route.ts`: authenticated dashboard adapter.
- `src/app/api/v1/messages/*`: public API callers of the shared send core; locate exact current routes before coding.
- `src/app/api/whatsapp/webhook/route.ts`: Meta inbound/status/template lifecycle path.
- `src/lib/automations/meta-send.ts`: automation send surface that must be inventoried and eventually routed neutrally.
- broadcast core/resume code under `src/lib/whatsapp` and API routes under `src/app/api/whatsapp/broadcast`.
- `docs/architecture/messaging-business-events.md`: transport separation rules.

### Deliverables
1. Exact caller inventory for all Meta send functions and inbound dispatch paths.
2. Provider capability matrix covering text, media, replies, interactive messages, official templates, statuses, QR auth, groups and unsupported features.
3. Provider-neutral request/result/error contract.
4. Explicit mapping of Meta-only semantics: approved templates, WABA/phone number ID, customer-service window, `wamid`, Graph errors.
5. No production code behavior change.

### Proposed contract shape
The implementation may use different names if the existing architecture dictates, but the contract must express:
- connection/provider identity
- recipient identity
- normalized content
- reply/context reference
- stable WACRM idempotency key
- provider message ID
- provider-specific metadata kept behind adapter boundary
- normalized failure classification (retryable, permanent, restriction, ambiguous/reconcile)

### Exit gate
Architecture review complete; every current outbound caller is mapped; Meta regression baseline is green.

---

## OW-1 — Provider-Neutral Data Model

### Existing schema facts
The historical schema contains `contacts`, `conversations`, `messages`, and `whatsapp_config`. The current branch has later account/tenant migrations, so OW-1 MUST inspect all later migrations before choosing final DDL. Never modify `001_initial_schema.sql` or any applied migration.

### Target model
Prefer an additive `whatsapp_connections` concept that can represent both Meta and OpenWA. Required logical attributes:
- primary key
- `account_id`
- provider (`meta_cloud` / `openwa`)
- display/phone identity
- connection lifecycle status
- provider external/session identity
- optional OpenWA instance placement
- provider metadata for non-routing extras
- timestamps

Meta data that must remain supported:
- `phone_number_id`
- `waba_id`
- encrypted access/verify credentials

OpenWA data likely required:
- session ID
- instance ID/base placement reference
- engine metadata
- connected/disconnected/restricted timestamps/state
- credential reference, encrypted/server-only

### Message identity migration direction
Current `messages.message_id` and broadcast `wamid` compatibility cannot be broken. Add provider-neutral identity first, backfill/mirror where safe, migrate readers/writers, and retire Meta-specific assumptions only in a later explicit compatibility phase.

Candidate logical fields:
- `connection_id`
- `provider`
- `provider_message_id`

Uniqueness must be scoped correctly; a provider message ID alone is not assumed globally safe across providers/connections.

### RLS/security requirements
- authenticated users may access only connections belonging to accounts where they hold the required role.
- QR/session control requires admin-level capability unless existing role model proves a safer equivalent.
- no client-readable plaintext provider credentials.
- service-role webhook resolution must still filter/resolve by account/connection and must not turn into an unscoped lookup.
- explicit cross-tenant tests are mandatory.

### Migration rules
1. Append-only new migration(s).
2. Clean replay must pass.
3. Existing Meta rows must continue working throughout migration.
4. Backfills must be deterministic/idempotent.
5. Indexes must cover inbound provider/session resolution and outbound connection selection.
6. Rollback is logical/feature-gated; never depend on destructive downgrade of already-applied DDL.

### Tests
- migration clean replay
- schema assertions
- owner/account access
- cross-account denial
- role checks for connection mutation
- credential non-exposure
- Meta legacy row compatibility

### Exit gate
Schema/RLS verified on TEST, Meta configuration/send/webhook regression green, and no new Supabase advisor finding attributable to the phase. Existing NOTE-001 remains separately tracked.
