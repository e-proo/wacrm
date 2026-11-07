# OW-12 — Pre-Live / Negative Acceptance Evidence

Recorded: 2026-10-26

This document deliberately separates evidence that can be verified without a live OpenWA service/session from the OW-12 scenarios that require a real TEST OpenWA endpoint, server-side credential, and dedicated/non-critical WhatsApp number.

## Evidence anchor

- Branch: `refactor/service-platform-v2`
- Starting HEAD: `188c3d152a4135b059a8a8f9e7cac735e69643ef`
- OW-11 final CI: #925 / run `40385141206`
- CI job `121791943792`: Lint, Typecheck, Test, Build = success.
- TEST Supabase project: `wacrm test` (`pqirsnfupofhulmewakq`).
- TEST database check on 2026-10-26: one `meta_cloud / connected` connection; zero OpenWA connections; zero OpenWA credential records.
- No Production environment was modified.
- No fake OpenWA credential was persisted because it would not increase live-acceptance evidence and would create unnecessary secret/configuration state.

## Pre-live / negative acceptance verified

The following safety and integration behavior is covered by the implementation and green automated TEST/CI suite from OW-3 through OW-11 and is accepted as pre-live evidence, not as live provider evidence:

- server-only OpenWA credential boundary; credentials are not exposed to agents/business callers.
- account/connection-scoped provider resolution and fail-closed behavior for missing/invalid configuration.
- signed webhook verification, replay protection, and durable duplicate-event deduplication.
- provider-neutral inbound normalization and one WACRM CRM/business fan-out pipeline.
- provider-neutral outbound routing with stable WACRM idempotency reservation before provider dispatch.
- ambiguous provider outcome semantics prohibit blind resend and require reconciliation.
- media validation/storage boundary remains WACRM-controlled; provider media URLs/credentials are not durable business identity.
- status/ack lifecycle is provider + connection + provider-message scoped and protects against duplicate/stale transitions.
- OpenWA safety/anti-abuse guardrails, including workload classification, caps, spacing, circuit breaking and pause controls.
- agents, automations, Flows, public API and broadcasts route through the shared WACRM transport boundary; callers do not choose OpenWA engine or receive session credentials.
- Meta remains the default/official provider and the Meta regression suite is green in CI #925.

## TEST environment negative state

Current TEST state is intentionally safe for continuation of non-live work:

- OpenWA connections: `0`.
- OpenWA credential records: `0`.
- Therefore no OpenWA business send can be truthfully treated as a live provider acceptance result.
- There is no need to persist a fake credential merely to force an authentication failure; the unit/integration suite already verifies invalid/missing configuration and transport failure semantics without contaminating TEST configuration.

## Scenarios still requiring real live OpenWA TEST infrastructure

These remain unchecked for OW-12 live acceptance:

- create OpenWA session and scan QR.
- ready state after WhatsApp authentication.
- real inbound/outbound text.
- real swipe reply/context.
- real image/video/audio/document transport.
- real delivery/read status where emitted.
- disconnect/reconnect against the provider.
- WACRM restart with live session continuity.
- OpenWA restart/session recovery.
- duplicate webhook delivery against a real provider event.
- ambiguous outbound timeout followed by live reconciliation.
- real restriction/logged-out provider event where safely reproducible (a safe provider fixture may supplement restriction testing but does not replace session acceptance).
- real automation send.
- real agent send.
- bounded live broadcast.
- live cross-tenant negative checks using an actual OpenWA connection/session.
- Meta regression on the same TEST environment while the live OpenWA connection is present.

## Gate and continuation decision

OW-12 is **not closed**. Its status remains `In Progress` until the live scenarios above are executed with a reachable non-production OpenWA service, valid server-side TEST credential and dedicated/non-critical WhatsApp number.

The completed pre-live/negative evidence is sufficient to continue preparing later phases that do not claim a live pilot or production readiness. It is **not** sufficient to start OW-13 bounded pilot execution, because OW-13 requires OW-12 live acceptance first.

Allowed continuation while NOTE-007 remains open:

- prepare OW-13 pilot design, allowlist/feature-flag controls, observability, stop conditions, rollback procedure and evidence template.
- prepare OW-14 rollout-decision documentation/checklists.
- continue CI/regression/security work that does not depend on a real OpenWA session.

Not allowed to claim:

- `OW-12 live acceptance complete`.
- `OW-13 pilot accepted`.
- `production ready` / GA.

## Deferred dependency

The live dependency remains tracked by `PROJECT_NOTES.md` NOTE-007 and Linear SOF-41. When a real TEST OpenWA endpoint + credential + non-critical WhatsApp number become available, resume this file by appending live timestamps, redacted connection/provider identifiers, scenario results, CI/migration state and any incidents/reconciliation evidence.

---

## Superseding live TEST checkpoint — 2026-11-07 (addendum)

The **2026-10-26** statements above about zero OpenWA sessions and a missing live external dependency are preserved as historical pre-live evidence. They are **no longer a description of the current TEST environment**.

- Tested two local services linked via separate HTTPS Cloudflare quick tunnels. WACRM created an OpenWA session (HTTP 201), returned an authorized short-lived QR (HTTP 200), and displayed Ready. TEST now holds two `openwa/ready` connections plus one separate `meta_cloud/connected` connection.
- Early signed Webhooks failed 400 with `PGRST205` (receipt table absent). Existing migrations `147_openwa_webhook_event_receipts.sql` and `148_whatsapp_outbound_idempotency.sql` were applied to TEST, with PostgREST schema refresh. Webhooks then returned `202`.
- AI agent execution initially succeeded but OpenWA outbound returned 400 due to a misaddressed `@lid` chat. Fix: persist verified original `messages.provider_chat_id`, route only within the account+conversation+connection scope, fail closed on legacy/untrusted identity, protect JID via server-only constraint/trigger; additive migrations `150_openwa_inbound_chat_identity.sql` and `151_openwa_chat_identity_server_only.sql` applied to TEST. Implementation HEAD `91e628e03aa8e615b8a6c5e5ca924a1e062e849f`.
- Live retest logs: `POST /api/whatsapp/openwa/webhook 202`, `[ai dispatch] SENT` and provider ID referencing `@lid`. TEST DB: new inbound `delivered` with `provider_chat_id @lid`; bot reply `read`. One earlier bot row still `sending` without provider ID and must not be blind-resubmitted.
- **Evidence level:** OW-4 live session/QR happy-path verified; OW-12 live text+AI+read happy-path partially verified. NOT complete OW-12 acceptance. Media, quoted reply, restart/reconnect, duplicate, ambiguous reconciliation, automation, bounded broadcast, live tenant isolation and concurrent Meta regression remain to be proven.
- **Current-head CI missing:** Last visible green branch CI run 42123370242 applies to `bbab5812`, before the new inbound/outbound LID routing fixes. Do not close SOF-33 or SOF-41 on the strength of the historic run.
- **Source record:** [Linear OpenWA Live TEST Checkpoint](https://linear.app/eproo/document/openwa-live-test-checkpoint-2026-11-07-ow-4-ow-12-1e473cda8576). No Production changes. NOTE-001 remains open for production approval.


## OW-4 closure gate reconciliation — 2026-11-07

This is an **OW-4** phase-closure addendum, not evidence that all OW-12 live acceptance scenarios have passed.

- Live TEST WACRM admin created an OpenWA session, obtained a secure short-lived QR, and connected through to `ready` as documented above; original NOTE-007 external TEST dependency is resolved.
- [PR #3](https://github.com/e-proo/wacrm/pull/3) merged into `refactor/service-platform-v2` at `c87fd13cf68df1cc6757fd910a7761e9110ff411`.
- Both GitHub Actions workflows on the exact merge commit passed: [CI #42410328689](https://github.com/e-proo/wacrm/actions/runs/42410328689) lint, typecheck, focused OW-4 session/QR + Meta regression, full tests, build = success; [Migrations #42410328723](https://github.com/e-proo/wacrm/actions/runs/42410328723) clean database replay, OW-4 session/credential/RLS gate, remaining schema/integration smoke checks = success.
- Clean-replay-only lack of `service_role` credential grants was corrected additively by `152_openwa_service_role_credential_grants.sql`. Migration applied to TEST and validated: `service_role` CRUD, no `anon` or `authenticated` SELECT, credentials table RLS enabled. No Production changes.
- Therefore SOF-33/OW-4 closure level: **implementation complete + live TEST session/QR verified + CI verified**. OW-12 remains **In Progress / partially live verified** with media/restart/reconciliation/automation/broadcast/tenant/Meta-live cases still outstanding and a historical ambiguous `sending` row requiring safe reconciliation.
