# OW14-W07-03 — Authenticated operational policy / activation API

**Status:** Implementation candidate; check exact-HEAD CI. No hosted Supabase TEST or VPS changes, no live send or Production authorization.
**Date:** 2026-11-20. **Branch:** refactor/service-platform-v2. **Linear:** SOF-54.
**Predecessors:** W07-00 ADR, W07-01 bilingual draft, W07-02 migration 204 and invoker RPCs.

## Reuse existing authorization and transport

- Every endpoint uses the existing server-only requireRole context from src/lib/auth/account.ts. The server resolves the actual caller with Supabase Auth getUser(), and the role and account are read from profiles using the caller's RLS-scoped SSR client.
- Only after authorization does the server use the existing service-role Supabase client from src/lib/flows/admin-client.ts to read private tables and call SQL RPCs.
- The browser cannot choose account_id or actor_id; extra JSON fields are rejected. The server supplies the trusted session account and user, and the SQL functions independently verify current membership, connection provider, expected revision and request id.
- No new outbound engine, session creation, QR, Meta route, worker, webhook or OpenWA gateway call. These endpoints only read/record administrative intent.

## API 1 — GET /api/whatsapp/connections/openwa/operational-policy

**Role:** Owner or Admin, not Agent or Viewer. Returns:

- Current independently approved policy version/digest if published (migration 204 starts with NO approved policies).
- Account consent status/revision; does not expose consent acceptance event ID to the browser.
- Tenant-scoped nonarchived OpenWA connections with display name, readiness, requested activation state/revision and safe reason codes. Linked device session IDs are read only to check readiness and NEVER returned.
- Up to twenty latest account-scoped consent and activation audit entries (actor UUID, action, revision, timestamp and scoped connection ID), without QR, phone number, JID, message body, provider ID, credential, secret or private gateway URL.
- The response ALWAYS states operational_gate=pending_w07_04 and send_authorized=false. This is informational only, not a provider dispatch decision.
- Fail closed as HTTP 503/control_unavailable when migration is not applied or a scoped DB read fails; never assume an error means consent.

## API 2 — POST /api/whatsapp/connections/openwa/operational-policy

**Role:** Owner only. POST requires bounded JSON <= 4 KiB, exact origin, a trusted HTTPS NEXT_PUBLIC_SITE_URL in Production and an explicit UUID request_id.

**Accept:** action=accept, policy_version, 64-character lowercase SHA-256 policy_digest, acknowledge_risks=true, expected_revision and request_id. W07 draft version is rejected. SQL also requires a published CURRENT approved version/digest matching exactly.

**Revoke:** action=revoke, expected_revision and request_id only. Accepted/revoked history remains append-only. Revoke is available even while the stage switch blocks new acceptance.

**Default safety:** WACRM_W07_CONTROL_WRITES_ENABLED is OFF by default. Explicit value true allows an accept request through the API, but cannot publish policy versions and is NOT an OpenWA sending release gate. Leave OFF until W07-04 and Product/Legal approval.

The API calls the SECURITY INVOKER service-role-only set_openwa_operational_consent function. SQL verifies the current owner, tenant, approved policy, serializes by account lock, performs compare-and-set by revision, deduplicates request UUID, and appends the audit event atomically.

## API 3 — POST /api/whatsapp/connections/openwa/{connectionId}/operational-activation

**Role:** Owner or Admin. Path must be UUID; body must contain exactly one action, revision and UUID request_id.

- Enable: action=enable, confirm_activation=true, expected_revision, request_id; closed by default until the W07 control stage is explicitly enabled and SQL verifies a current approved owner consent plus ready same-account OpenWA session.
- Disable: action=disable, expected_revision, request_id.
- Suspend: action=suspend, expected_revision, request_id.
- Disable and suspend remain available independently of the stage switch for safe containment. They do not start/stop sessions or workers and do not send/redo queued messages.

Calls the SECURITY INVOKER service-role-only set_openwa_operational_activation RPC. The RPC checks the account, connection, provider, current consent event, optimistic revision and idempotency. An activation binds to the exact current accepted_event_id. Revoking and reaccepting the same version produces a new event; prior activation cannot silently revive.

## Response and security rules

- No-store private responses, with no server/provider/database error details, keys or secrets leaked.
- Stable denial codes with mapped HTTP statuses: unauthorized 401, forbidden/invalid_origin 403, invalid_request/invalid_connection 400, connection_scope_mismatch 404, policy_not_approved/consent_required/session_not_ready/revision_conflict/request_conflict/control_stage_not_ready 409, control_unavailable 503.
- Successful records and idempotent replays are explicitly historical records, always send_authorized=false and state_requires_refresh=true.
- Origin validation is strict (missing/null/cross-site denied). Without configured trusted HTTPS origin in Production, writes fail closed. JSON stream is limited to 4 KiB, even if chunked.
- Browser can never directly SELECT/UPDATE the new tables, which have RLS and service-role-only grants.
- Meta remains official/default. No automatic OpenWA fallback or blind resend. Inbound webhooks/ACK/reconciliation are unaffected.
- No direct runtime send enforcement exists in W07-03. The W07-04 common transport gate remains an independent mandatory prerequisite to describing this as a working Production opt-in.

## Verification and operations

The pure API contract and both route files have direct Vitest tests for owner/admin/unauthenticated roles, absent/forged actor/account, cross-origin/oversized/extra-key JSON, stage default disabled, DB failure redaction, scoped connection identity, revision conflict, idempotent replay, successful and denied RPC calls, plus GET redaction and no false send permission.

W07-02 additive migration 204 and SQL clean-replay security smoke were already verified on disposable CI DB; NOT applied to hosted Supabase TEST. A new exact-HEAD CI run must succeed in lint, typecheck, tests and build for W07-03.

**Next:** W07-04 single fail-closed OpenWA dispatch guard (live approved version/digest + accepted_event_id + requested connection activation + production release gate + existing manual STOP, circuit, workload, recipient eligibility), and then W07-05 functional activation UX after validated TEST deployment. The W07-01 risk dialog remains nonmutating until then.

**Do not deploy to VPS, apply hosted migrations, enable the stage, publish a draft policy, or run a live WhatsApp test as part of W07-03.**
