# OW14-W07-04 — Shared OpenWA outbound operational consent gate

**Date:** 2026-11-20. **Issue:** SOF-54. **Evidence level:** implementation complete + exact-HEAD CI verified. Hosted TEST/live acceptance and Production readiness remain pending.
**Branch:** refactor/service-platform-v2.
**Dependencies:** W07-00 policy design, W07-01 copy, W07-02 migration 204 and W07-03 authenticated API.

## Architecture and shared path

Existing WACRM:
- Tenant-scoped router resolves Meta (default) or explicit OpenWA.
- OpenWA resolution verifies same-account ready nonarchived session, server-only credentials.
- GuardedOpenWATransport applies Pilot/workload allowlist, emergency stop/circuit, atomic cap reservation and pacing.
- OpenWAWhatsAppTransport.send is the last boundary before REST sendText/sendMedia with the same stable idempotency key.

**W07-04 adds two checks:**
1. Before guardrail reservation, GuardedOpenWATransport verifies current approved policy, current owner acceptance, per-connection activation and live same-account session.
2. Immediately before native provider request, raw OpenWAWhatsAppTransport verifies again, including that the live session_id is the same as the one resolved before pacing. This also prevents callers bypassing the guarded router wrapper by calling the raw adapter directly.

The last check detects a revoke, reacceptance, suspension, stale policy or session rotation during queued/reserved/paced work. Already-started native requests may still finish, and MUST use existing reconciliation instead of blind retries. For production, the emergency stop is also rechecked after reservation, even for zero pacing delay.

## Required per-send proof

- Non-TEST environments need the exact deployment-only server environment flag WACRM_OPENWA_PRODUCTION_RELEASE_ENABLED=true. Missing, false or malformed values block BEFORE reading DB or reserving capacity. The flag is not exposed to browsers or agents.
- Exactly one currently approved policy version/digest with a valid SHA-256 hash exists (migration 204 seeds NONE).
- Account's consent status=accepted, its policy version and digest exactly match the currently approved policy, and accepted_event_id is present.
- This account's exact connection has requested status=enabled and consent_event_id equal to the CURRENT accepted_event_id. Suspend, disable and a revoke/reaccept do not preserve old activation.
- The original acceptance audit event exists in the same account, action=accept, matching current approved policy version/digest.
- Same-account provider=openwa, nonarchived, ready/connected session with nonempty session_id exists. The raw adapter must additionally match its resolved session ID.
- Existing manual pause/circuit, workload/cap/pacing, TEST Pilot allowlist and recipient/business permission remain independent blocking checks.
- A missing row, SQL error, unknown schema or inconsistent proof fails closed. No provider send is inferred.

**Production vs TEST separation:** The pinned Supabase TEST project retains its preexisting Pilot and guardrail behavior by default so existing Windows-local development is not abruptly blocked; this is NOT Production opt-in. Set WACRM_W07_TEST_GATE_MODE=enforce on that pinned TEST environment to exercise W07 policy checks in a controlled acceptance run. Invalid TEST gate values deny. ALL non-TEST project URLs (including malformed/unknown ones) enforce W07 and require the separate Production release flag. Retiring the transitional TEST carveout and running bounded live acceptance are future explicit release decisions.

## Sources changed

- src/lib/whatsapp/transport/openwa/environment.ts — strict centralized pinned TEST URL detection, formerly in guardrails.
- src/lib/whatsapp/transport/openwa/pre-dispatch-denied.ts — shared providerDispatchAttempted=false local denial class.
- src/lib/whatsapp/transport/openwa/operational-consent-gate.ts — server-only environment/release/current-policy+consent+activation/audit+session proof.
- src/lib/whatsapp/transport/guardrails.ts — first proof before capacity; unconditional STOP recheck in effective W07 modes; never attribute final adapter local denial to provider failure.
- src/lib/whatsapp/transport/openwa/adapter.ts — last proof plus live session identity; no text/media/reply/idempotency changes.
- src/app/api/whatsapp/connections/openwa/operational-policy/route.ts — reports actual W07 mode and deployment flag, without claiming blanket send authorization.
- src/lib/whatsapp/transport/openwa/operational-consent-gate.test.ts — negative matrix covering missing policy/consent/activation, stale policy and event, wrong tenant/session, DB error and TEST/production config.
- src/lib/whatsapp/transport/openwa/operational-consent-integration.test.ts — actual Guarded plus raw Adapter with all five workloads, media, revoked consent after reserve, suspended activation, session rotation, STOP and raw bypass.
- Legacy router/adapter/guardrails tests isolate the existing behaviors from the new gate; W07 security tests use the REAL gate without mocks.

## Environment and behavioral matrix

| Target | W07 gate | Release flag | Operational behavior |
| --- | --- | --- | --- |
| Pinned TEST, default | Transitional legacy TEST | N/A | Existing Pilot/guardrail only, no implied Product/Legal consent |
| Pinned TEST with WACRM_W07_TEST_GATE_MODE=enforce | Full proof | N/A | Current approved version + owner acceptance + same-event activation + existing Pilot/STOP required |
| Production/non-TEST, no release flag | Enforced | Off | All OpenWA outbound denied before reservation/native send |
| Production/non-TEST with release flag but missing/currently revoked/outdated consent | Enforced | On | Denied pre-dispatch |
| Production/non-TEST with all approvals current | Enforced | On | Proceeds only to remaining independent guardrail/recipient/policy checks |
| Meta Cloud API | Not applicable | N/A | Official/default Meta behavior unchanged |
| OpenWA inbound, ACK/read, reconciliation | Not applicable | N/A | Remains available even with OpenWA outbound blocked |

## API consistency

The admin GET operational-policy summary now describes the installed gate as legacy_test / enforce_test / enforce_release, and reports whether a non-TEST deployment release flag is on. A summary must NOT claim send_authorized=true because each recipient/workload requires a fresh and separate dispatch check. The W07-01 preview remains informational until W07-05. W07-03 owner accept/admin enable remain independently gated by WACRM_W07_CONTROL_WRITES_ENABLED (OFF by default).

## Failure evidence and rollback

W07 denial is an OpenWAPreDispatchDenied with providerDispatchAttempted=false and a safe reason code, not a provider timeout/ack and never a delivery assertion. The wrapper does not record final-adapter W07 denials as native provider failures. Unknown outcomes after the actual native call still require normal reconciliation.

No schema changes in W07-04; W07-02 additive migration 204 is prerequisite on each actual environment. No applied migration is edited. To recover safely from a future incident, keep Production release flag OFF and/or use the existing emergency STOP; neither deletes OpenWA profile data or changes Meta routing.

## Required acceptance

- [x] Exact-HEAD completed/success lint, TypeScript, full Vitest, Meta/OpenWA regression and Next.js Build — implementation SHA 561d49377525cad8d093d1767426aac02d16ca6d, run https://github.com/e-proo/wacrm/actions/runs/44745635876
- [ ] Confirm W07-02 SQL clean replay remains successful; no new migration.
- [ ] Later: authorized hosted TEST migration, Product/Legal-reviewed policy registry publication, account owner/API approval and W07 test-enforced lifecycle proof; live WhatsApp acceptance is explicitly deferred.
- [ ] Later: W07-05 polished functional admin UI, W07-06 support, W07-07 broader gates, W07-08 bounded acceptance.
- [ ] W06 backup/DR, NOTE-001 security debt and W09 Production GO remain separate blockers.

**No VPS restart/deploy, hosted Supabase TEST/Production modification, worker relocation, OpenWA gateway change, or live WhatsApp send was authorized or executed in this code-only package.**


## Verification record — 2026-11-20

Runtime implementation SHA: 561d49377525cad8d093d1767426aac02d16ca6d. GitHub CI run 44745635876 completed/success on this exact SHA, including new W07 real-adapter tests, prior Meta/OW-4 gate, full Vitest suite, TypeScript, Lint, and Next.js Build. No hosted TEST migration/production/VPS side effects; no live acceptance. Any later documentation-only commit must not be mistaken for a runtime change.
