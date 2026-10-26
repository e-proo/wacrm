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