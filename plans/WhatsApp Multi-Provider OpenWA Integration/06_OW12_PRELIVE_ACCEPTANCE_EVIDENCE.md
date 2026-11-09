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

## Media ACK remediation and TEST verification checkpoint — 2026-11-09

- Source branch verified at `bbd4257` before remediation. CI run `42631069794` failed on a numeric-string ACK test; corrected regex in `d31878e`.
- OpenWA status parser now accepts numeric ACK -1/1/2/3/4 and nested message identities, preserving provider+connection scoping. The webhook also performs a bounded **database lookup only** retry when a provider receipt precedes persistence of its message ID; no provider resend is performed. The bounded retry does **not** reconcile long ambiguous timeouts.
- Live TEST Supabase (`pqirsnfupofhulmewakq`) read-only aggregate at checkpoint: 8 agent-originated OpenWA rows over the preceding 7 days: 3 `read` (2 text, 1 image), 1 `sent` document, and 4 `sending` without provider IDs (2 text, 1 image, 1 video). These 4 are **unresolved**, not proof of failed delivery, and must not be blindly resent or marked delivered.
- The same TEST project had 194 OpenWA webhook receipt reservations over the preceding 48 hours with zero recorded processing errors. This does **not** prove receipt status parsing or actual read acknowledgment; unmatched/unrecognized ACK events previously lacked safe diagnostic logs.
- Current-head CI and live media read/delivery acceptance are **pending**. No Production modifications.

### Operator live TEST run (record actual results before closure)

1. Pull the verified HEAD after CI success and restart the WACRM TEST server; keep the existing OpenWA session and webhook signing configuration. Confirm the provider connection is `ready`.
2. Send **one new** text, image, video and document from WACRM to a dedicated TEST recipient. For each, record the local message row ID, returned provider message ID (redacted), `sent` time and subsequent `delivered`/`read` transitions. Open the messages on the recipient device after initial delivery.
3. Check server logs for `[openwa-webhook] unmatched delivery receipt` or `unrecognized delivery receipt` (safe metadata only). A delivered/read event should match the same `provider_message_id` and `connection_id`. If an event is never emitted by the upstream gateway, do not fabricate read status.
4. Inspect TEST database `messages` rows for these **new** message IDs. Expect `sent -> delivered -> read` where the gateway emits both receipts, or `sent -> read` if only a read event is emitted. Confirm `provider_message_id` is present and no duplicate messages were sent.
5. Independently execute remaining OW-12 live matrix: reply context, audio, session restart/reconnect, webhook replay, ambiguous reconciliation, automation, bounded broadcast, cross-tenant negatives and Meta regression while OpenWA is active. Attach timestamps and redacted evidence to SOF-41.
6. Never automatically retry the 4 historical `sending` rows without provider-side reconciliation. Leave OW-12 open until all applicable gates are evidenced.

## OpenWA settings/API 404 troubleshooting — 2026-11-09

Local TEST report: the WhatsApp settings page showed `Unexpected token '<' … is not valid JSON`; `GET /api/whatsapp/connections/openwa` returned 404, as did some `POST /api/whatsapp/openwa/read` and `POST /api/whatsapp/openwa/webhook` calls.

- The green branch CI for `1f6c92b` (run 42631796500) **built and registered all three App Router routes**. The connections-list GET handler never emits 404 on its own, so a 404 HTML response for that URL is evidence of a local route-serving/build mismatch, not an OpenWA API error. Restart the right working tree and Next.js dev server after updating HEAD; clear only the generated `.next` folder while the server is stopped if a stale Turbopack manifest persists.
- TEST database read-only evidence: 12 OpenWA connections, including 3 `ready`; every OpenWA `whatsapp_connections.instance_id` is NULL in this snapshot. The signed webhook verifier formerly required a matching instance ID when an upstream envelope supplied it, which can turn a valid legacy session event into `Unknown OpenWA session` (HTTP 404). The patch permits a **single unambiguous session lookup**, checks scoped credentials and HMAC, then binds the initial `instance_id` through a tenant-scoped null-only compare-and-set. Conflicting instance IDs, invalid signatures and duplicate session identities fail closed. This is a plausible webhook 404 cause, but individual rejected events were not available for direct comparison.
- An Inbox read POST can independently return a JSON 404 when the authenticated user's account cannot access the requested conversation. The example conversation from the local log exists in TEST and contains native OpenWA inbound messages; the user's authenticated account and exact rejected response still need verification.
- The settings client now distinguishes an HTML route 404 from a legitimate JSON error and never renders untrusted HTML or credentials as a toast. Tests cover this behavior and webhook instance binding.
- These fixes do not modify Production and do not imply OW-12 live acceptance. Recheck the exact CI HEAD, reconnect a real TEST session as needed, then verify signed webhook 202, settings JSON 200, read acknowledgements and media send/ack/read without blind resend. Record redacted event evidence and complete the remaining live matrix.

## OW-12 webhook abort and video send hardening — 2026-11-09

**Observed user TEST report (not closure evidence):** OpenWA signed webhook requests returned HTTP 202 and duplicate 200 around local `Error: aborted`; one video send ended `400` after ~38 seconds, another `409 ambiguous_outcome` after ~81 seconds, and one later media archive download returned `404`. Other text/image/document/video attempts succeeded and some reached `read`. Different HTTP outcomes must NOT be conflated.

**Root reliability defect before fix:** WACRM inserted `whatsapp_webhook_event_receipts` and immediately returned 202 while performing CRM work in a Next.js `after()` callback. A canceled callback could leave `processed_at IS NULL`; the old duplicate path returned 200 anyway, permanently suppressing gateway redelivery. Prior TEST read-only count: seven such incomplete receipts. No original signed payload is stored for these historical rows; they cannot be reconstructed from the receipt ledger alone.

**Implementation and scoped TEST deployment:**

- Additive `153_openwa_webhook_processing_leases.sql`: server-only `processing_token`, `processing_started_at`, `processing_attempts` and a partial index. Applied to TEST `pqirsnfupofhulmewakq`. Confirmed the columns are present. No Production change; existing RLS/credential boundary unchanged.
- Webhook completion is now awaited **before** returning 202. Completed signed duplicates return 200. Concurrent/in-flight delivery returns 503 with Retry-After; an expired or failed lease may be reclaimed only by a new HMAC-verified delivery using a tenant + connection + event-scoped compare-and-set. A failed handler stores a fixed sanitized error code with `processed_at NULL` and returns 503. This reprocesses only the signed inbound event; **never retries a WhatsApp outbound send**.
- New unit/route tests cover normal completion, double delivery, pending lease, expired legacy receipt, CAS contention, failed processing and the rule that no HTTP 2xx precedes successful processing.
- OpenWA REST client now extracts only a validated machine-readable provider error **code** on 400 (if supplied in JSON). It never relays untrusted provider message/URL/token data. Explicit `IDEMPOTENCY_OUTCOME_UNKNOWN` and HTTP 409/5xx retain ambiguous-outcome semantics and manual reconciliation. This improves diagnosis of `400`; it does not prove that upstream video encoding/download succeeds.
- CI at runtime HEAD `3b5bbccfd0f9ff8b9b8f45162efcff632cb117cf`: [run 42643435301](https://github.com/e-proo/wacrm/actions/runs/42643435301) **success** (lint, typecheck, tests, build). Clean replay of additive schema at migration commit `70671e7`: [Migrations run 42642155937](https://github.com/e-proo/wacrm/actions/runs/42642155937) **success**.

**Important limits:** The webhook fix requires OpenWA's signed redelivery for recovery. It does not provide a provider-independent durable payload queue; earlier unfinished receipts remain unresolved without redelivery or authorized operator review. Existing inbound/media handlers may log and swallow some best-effort media archive 404s, which require their own follow-up reconciliation. A long synchronous handler may exceed the server/platform duration and require gateway redelivery. Neither the origin of generic `Error: aborted` nor the exact upstream video 400 reason was established by the local log.

**Live TEST acceptance still required before closing SOF-41:**

1. Pull the new HEAD into the WACRM TEST runtime and restart it, leaving the existing OpenWA session intact. Confirm a new signed webhook returns 202 **after** the receipt gains `processed_at`; a repeat of the same signed event returns 200 only after completion. Inject a safe TEST failure/retry to prove a non-2xx is retried, and that no automation/agent/send duplicates occur.
2. For a fresh short, supported video and document, record send result, native provider message ID, receipt events, `sent → delivered → read` where emitted, and any safe machine error code on 400. An 81-second 409 still requires manual reconciliation, not another send.
3. Assess the seven historical unfinished receipts with gateway delivery logs or native records. Do not invent an original webhook payload or mark them completed without evidence. Retry media archive 404 via a separate read-only recovery workflow where provider media exists.
4. Execute the rest of the full OW-12 acceptance matrix (quoted reply, audio, restart/reconnect, ambiguous outcomes, automation, bounded broadcast, cross-tenant negatives and live Meta regression), then sync GitHub, TEST evidence and Linear. OW-12 stays **In Progress**, not production ready.
