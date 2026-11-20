# OW14-W07-02 — Versioned consent, account isolation and activation audit

**Status:** Additive migration prepared for clean CI database replay. Not applied to Supabase TEST/Production. No VPS or WhatsApp changes.
**Date:** 2026-11-20. **Tracker:** SOF-54.
**Migration:** supabase/migrations/204_openwa_operational_consent_activation.sql
**Verification:** supabase/ci/openwa-operational-consent-activation-smoke.sql, wired to GitHub Migrations workflow.

## Model: no implicit activation

The existing provider-neutral connection registry, Meta default, OpenWA transport, Pilot and worker behavior remain unchanged. Five new private server-owned tables provide:

1. **whatsapp_openwa_policy_versions** — approved versions and text SHA-256 digest; one current approved version at most. The registry is initially EMPTY. Only a future Product/Legal-approved additive migration may publish a version. service_role can SELECT, never INSERT/UPDATE.
2. **whatsapp_openwa_consent_audit** — append-only account owner accept/revoke event: account, actor, policy version/digest, revision, idempotency request UUID and timestamp.
3. **whatsapp_openwa_consent_state** — current account decision, monotonic revision, exact accepted_event_id and last actor. No row means not consented; revoked is not consented.
4. **whatsapp_openwa_activation_audit** — append-only per-connection admin/owner enable/disable/suspend with scoped actor, request UUID, revision and bound acceptance event.
5. **whatsapp_openwa_activation_state** — per-account/per-connection requested state. Default (missing row) is disabled; enabled requires a current approved owner acceptance and an eligible same-account OpenWA session.

Every new table has RLS enabled; anon and authenticated have no direct privileges. Audit tables allow service_role SELECT/INSERT only, not UPDATE/DELETE/TRUNCATE. New connection activation tables have composite account_id + connection_id FKs backed by a unique index on whatsapp_connections. The invoker RPCs have least-privilege service_role SELECT only on profiles(user_id,account_id,account_role) and whatsapp_connections(id,account_id,provider,archived_at,status,session_id), rather than broad UPDATE/SELECT access. No keys, QR, phone numbers, chat bodies, provider message IDs or transport secrets enter audit rows.

## Server-only RPC contract

### set_openwa_operational_consent

Parameters: p_account_id, p_actor, p_action, p_policy_version, p_policy_digest, p_expected_revision, p_request_id.

- Only current account owner via profiles.account_role may accept or revoke. Admin/agent/viewer and outside-account identities denied in SQL even when using service_role.
- Accept requires exact version+digest of the one currently approved policy. W07 draft copy is not approved; no row exists after migration.
- Revoke requires a previously accepted current decision. Transaction takes a W07-specific account-keyed advisory lock (without UPDATE permission on accounts); stale expected revision fails. Each request UUID is idempotent within account; conflicting reuse fails.
- The new acceptance event ID changes when an owner revokes and later reaccepts, even the same wording/version. Existing connection activation bound to the old acceptance is stale.

### set_openwa_operational_activation

Parameters: p_account_id, p_connection_id, p_actor, p_status, p_expected_revision, p_request_id.

- Owner/Admin only. The same account-keyed advisory transaction lock serializes consent and activation decisions. A limited-column read validates the exact provider=openwa, nonarchived connection without taking an UPDATE lock on existing session rows. Enable also requires ready/connected session and current approved owner acceptance.
- Per-connection revision + idempotency UUID guard duplicate, stale or conflicting requests. Disable and suspend remain possible without current consent.
- Enable stores the exact accepted_event_id from the owner's currently accepted policy. Reacceptance does not automatically revive old activation. Any future send gate MUST compare current acceptance event ID against the activation's event ID.
- No RPC sends WhatsApp, schedules a worker, creates a session, switches Meta or changes TEST Pilot.

Both RPCs are SECURITY INVOKER with empty search_path, executable by service_role ONLY. They verify the supplied actor's current database membership, but **W07-03 API MUST derive actor ID from authenticated server-side getUser()**, not JSON supplied by the browser. No UI or public Data API direct mutation is supported.

## Production dispatch remains blocked by pending W07-03/04

An activation row with status enabled is not send authorization. The future shared OpenWA dispatch guard must require: approved current version/digest, nonrevoked owner acceptance, enabled connection bound to the same current acceptance event, environment release gate explicitly ON after approval, valid session and tenant, existing manual STOP, circuit breaker, Pilot/workload/recipient policy, idempotency and last-moment recheck before provider call.

Meta remains official/default with no auto-fallback. Inbound webhook/ACK/reconciliation must remain available independently of outbound opt-in. W07-02 intentionally introduces NO runtime check so that existing TEST behavior is not silently disrupted; Production must remain NO-GO until W07-03/04 and OW14-W09 sign-off.

## SQL smoke coverage (ephemeral, rolled back)

- Zero rows / zero implicit published policy after migration.
- Role/ACL tests, RLS on all tables, no public RPC execution, service-only append-only audit.
- Synthetic policy fixture is created inside a transaction and fully rolled back.
- Unapproved policy and no-consent activation denied.
- Owner accept/revoke allowed; admin/agent/viewer/outside-account owner accept denied.
- Admin activation on own account only; cross-tenant connection and forged FK denied.
- Request-id idempotency and revision conflict.
- Revocation blocks further enable, reacceptance generates a distinct acceptance ID, explicit reactivation rebinds.
- All tests execute inside CI local disposable DB with a final ROLLBACK; no real session or send.

## Next implementation (W07-03)

Create authenticated account-scoped GET state/eligible connection status and POST owner consent/revoke + admin activation controls. Validate input with exact typed schemas, derive actor server-side, no-store output with safe codes only, no QR/credentials. API tests for 401/403/409, cross-tenant, duplicate requests and stale revision.

Do not convert W07-01 informational preview to a functional accept/activate UI until W07-03 API AND W07-04 runtime pre-dispatch gate have passed exact-HEAD CI and authorized TEST validation.

## Release and rollback

204 is a new additive migration, not an edit to existing applied files. Do not apply it to hosted TEST without separate authorization; GitHub Migrations clean replay is verification of the code only. After a migration has been applied, correct it with another additive migration. W06 encrypted backup/DR and W05/NOTE-001 Production gates remain open.
