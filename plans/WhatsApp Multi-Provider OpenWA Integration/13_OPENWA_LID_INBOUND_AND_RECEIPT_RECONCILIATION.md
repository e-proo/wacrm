# OpenWA native LID identity and delivery-receipt reconciliation — engineering work package

**Date:** 2026-11-17  
**Repository:** `e-proo/wacrm`, branch `refactor/service-platform-v2`  
**Baseline HEAD before initial implementation:** `46022d2b4ffffd91e5cc0a14408357a11068d459`  
**Scope:** TEST development / implementation preparation. **No Production authorization or GA claim.**

## 1. Observed failure and verified evidence

- User observed repeated signed `message.received` webhook `503` with `connection_restricted` when an unknown phone contacted the linked OpenWA session, while known-contact inbound triggered the multi-agent and sent a reply.
- Read-only TEST query on `wacrm test` project at audit: one referenced OpenWA connection `ready`, with phone identity populated, 39 persisted messages, 102 processed webhook receipts and 4 unresolved receipts (`connection_restricted`, 12 total processing attempts). These are read-only *snapshots*; they are not live E2E verification.
- The restriction is raised by `src/lib/whatsapp/transport/openwa/contact-identity.ts`: a native `@lid` is not a phone. Without a distinct, verified `senderPhone` or unique signed historical same-account/same-own-number binding it rejects CRM contact creation.
- `src/app/api/whatsapp/openwa/webhook/route.ts` retains a signed provider event for retry on processing failure; it returns `503`. Repeating the same `@lid` without new mapping cannot solve a permanent unknown identity.
- `src/lib/whatsapp/status-lifecycle.ts` matches receipts by `provider + connection_id + provider_message_id`; a fast ACK can race the outbound DB write. It retries a bounded window; unmatched status is currently logged and the signed event is finalized. It must not trigger WhatsApp resend.

## 2. Upstream OpenWA source research

**Upstream:** https://github.com/rmyndharis/OpenWA

- `src/config/feature-flags.ts`: `RESOLVE_LID_TO_PHONE=true` enables optional inline resolution; default is false.
- `src/modules/session/message-projector.service.ts`: for inbound non-self messages with `isLidSender`, attaches `incoming.senderPhone = await this.lidResolver.resolveSenderPhone(sessionId, sender)` before persistence/dispatch.
- `src/modules/session/session-lid-resolver.service.ts`: per-session bounded cache, shared read-through lookup, timed negative recheck and native LID/phone mapping persistence.
- `src/engine/adapters/wwebjs-contacts.ts`: `resolveContactPhone` uses `client.getContactLidAndPhone([contactId])` and reads `pn`; a missing mapping yields `null`.
- `src/engine/adapters/baileys-contacts.ts`: `resolveContactPhone` checks in-memory mapping, persisted LID mapping, then `sock.signalRepository.lidMapping.getPNForLID`; unknown does not justify guessing.
- Operator endpoint: `GET /api/sessions/{sessionId}/contacts/{contactId}/phone` -> `{contactId, phone: string | null}`. Requires a properly scoped API key and ready engine. The route uses `@lid` unchanged.
- Both upstream Compose files forward `RESOLVE_LID_TO_PHONE`. The dev Compose service is `openwa`; production Compose service is `openwa-api`. Restart/recreate service after env change; reloading the WhatsApp session is not sufficient.
- Never infer phone from `@lid` digits, contact names, addressbook suffixes or globally cached mappings from unrelated accounts. `senderPhone: null` is legitimate.

## 3. Completed code slice — account-scoped on-demand fallback

Initial commits after audit:
- `src/lib/whatsapp/transport/openwa/sender-phone.ts`: lookup through existing `resolveOpenWAClient(db, accountId, connectionId)`, using authenticated same-session `/contacts/{lid}/phone` endpoint, with 5-second bounded timeout and strict numeric-phone validation.
- `src/app/api/whatsapp/openwa/webhook/route.ts`: when a signed normalizer produces an unverified `@lid` sender, attempt the fallback before contact creation and unified processor.
- `src/lib/whatsapp/transport/openwa/sender-phone.test.ts`, `src/app/api/whatsapp/openwa/webhook/route.test.ts`: phone success, null/invalid/unrelated ids, trust boundary, timeout/retry behavior.

**This slice is not the complete solution.** Failed/unresolvable lookup still uses the existing signed `503` recovery. Do not declare live acceptance on the basis of the implementation alone. CI status is checked separately against the final exact HEAD.

## 4. Remaining implementation: durable unresolved inbound identity

**Goal:** Once a signed inbound has been verified and deduplicated, if its native chat is `@lid` and no authoritative number is available, *persist it durably and acknowledge it only after the persistence commits*, then retry identity resolution safely when it becomes possible.

Recommended design:
1. New additive migration only (never edit migrations 147/150/153 already applied) creates a service-role-only table such as `openwa_unresolved_inbound`: `account_id`, `connection_id`, `provider_event_id`, `provider_message_id`, `native_chat_id`, bounded sanitized normalized content, `state`, `retry_after`, `lease_token`, `attempts`, timestamps and `last_error_code`. Unique `(connection_id, provider_event_id)`, indexed retry and retention; enabled RLS with deny policies for `anon/authenticated`. No webhook signature/key, raw inline media bytes or decrypted credentials.
2. Split **identity preflight** from business processor so queueing only occurs when no CRM contact, conversation or AI/automation effect has yet occurred. In other words, never use a generic catch of all `connection_restricted` anywhere after processing.
3. On a verified unresolvable `@lid`, transactionally record the pending normalized event and mark the signed receipt completed. If durable save fails, release lease and return `503`; if saved, return `202` with safe `pending_identity` code. An invalid/mismatched chat must remain rejected; it is *not* authorized to form a contact.
4. Queue worker uses bounded claims/leases and exponential backoff. For each row, validate current account/connection/provider/session, reconsult the gateway, use unique historical binding only when trustworthy, and route a resolved event through the **existing** `processNormalizedInboundMessage`, preserving provider message ID, first-inbound and agent-task correlation. Do not add an OpenWA-only CRM, separate AI agent pipeline or duplicate-trigger dispatch.
5. Ensure reprocessing remains idempotent across crash/retry. Inspect `messages` unique `(conversation_id, message_id)` and durable agent task/AI processing semantics; add negative tests for concurrent claims, stale leases, out-of-order events, media fetch aging and session change.
6. Surface unresolved count + last safe reason + admin-only retry/reconcile in Settings/connection diagnostics, with no secret/phone guessing. A manual verified mapping must establish the exact `@lid` ↔ real phone proof from the same phone session; reject conflicting mappings.
7. Retention policy, max payload, operator triage for permanently unmapped senders, and safe repair migration for the historical failed receipts are required; **old failed events are not replayable from the receipt ledger alone**, which stores no raw payload. Use gateway's authenticated session history only after validating message ID/chat/account and confirm the original event semantics.

## 5. Remaining implementation: durable unmatched ACK / status

1. Normalize gateway `message.ack`, `message.receipt`, `message.failed` and event-specific payloads to exact native WhatsApp `providerMessageId`, connection and status. Never use webhook delivery ID as the message ID; preserve exact byte/string form of the native ID.
2. Before finalizing an unmatched signed status event, store a bounded service-role-only **pending receipt**, keyed by signed event ID and same account/connection; include normalized status, original native message ID, status timestamp and safe diagnostic code, not arbitrary provider message payload.
3. Once outbound engine commit/own-sent echo inserts `provider_message_id`, reconcile the pending status; the background worker also periodically revisits still-unmatched receipts with bounded retry/expiry. Status transitions remain monotonic; never transition `read` backwards to `sent`.
4. Verify both messages and broadcast recipients. Provider timeouts remain ambiguous and require reconciliation, **never blind resend**.
5. Tests: ACK before outbound DB write; ACK after, unknown native ID, wrong connection/tenant, reordered `read/delivered/sent`, duplicates, retry across worker crash, ambiguous timeout, receipt orphan observability.

## 6. TEST acceptance matrix and exact evidence

- New unsaved phone with `@c.us` inbound -> contact created exactly once, unified inbox receives, AI responds once.
- New unsaved `@lid`, signed senderPhone present -> correct real phone, native chat kept intact, reply delivered.
- New `@lid`, senderPhone absent but on-demand API resolves -> same result, without adding contact beforehand.
- New `@lid`, both mechanisms return null -> **pending durable row + acknowledged signed event**, no fake phone/contact/agent invocation; after verified mapping worker processes once.
- Same event delivered twice/concurrently and after restart -> one contact/message/business fan-out.
- Conflicting LID ↔ phone mapping and forged/wrong tenant/session/chat -> no cross-account contact binding or side effects.
- Inbound/outbound media and reply context survive deferred processing; no secret/base64 persistence.
- Fast `sent`, `delivered`, `read` ACKs before DB row, backdated and duplicate ACKs -> correct monotonic final state; no WhatsApp resend.
- Meta Cloud API path and historical OpenWA interactions regressions pass.
- Record focused Vitest output, SQL migration replay, TEST migration ledger, latest exact HEAD CI and a real two-number OpenWA TEST acceptance trace. Do not mark complete/production-ready without all mandatory evidence.

## 7. Immediate operator checklist (TEST OpenWA)

1. On the machine running the **OpenWA repo**, write `RESOLVE_LID_TO_PHONE=true` in its own `.env`, not WACRM's `.env.local`.
2. Validate Compose forwarding with `docker compose -f docker-compose.dev.yml config` (if running dev Compose), then `docker compose -f docker-compose.dev.yml up -d --no-deps --force-recreate openwa`. For production-style Compose in local TEST, target service `openwa-api` instead. Preserve mounted session profiles; do not use `down -v`.
3. Verify from the host using the existing scoped API key, without printing secrets: `GET http://localhost:2785/api/sessions/{sessionId}/contacts/{lid}@lid/phone`; expected `phone` is the real MSISDN or `null`.
4. Send a new message from one **unsaved** test number, inspect signed `message.received` event fields and WACRM receipt; only `senderPhone` (never LID digits) may initialize the contact.
5. Re-run with a known contact, verify AI and ACK, and preserve timestamps/event IDs for acceptance evidence.

**Status at authoring (superseded by the implementation evidence below):** preliminary design. See the current status in §8. No Production change authorized.


## 8. Implementation and verification evidence — 2026-11-17

**Canonical branch:** `refactor/service-platform-v2`  
**Implementation verification HEAD:** `34ea9c981d6b7d00630d4759a07731106a235fcf`  
**GitHub CI:** https://github.com/e-proo/wacrm/actions/runs/43999551280 — **success** (Lint, Typecheck, Test, Build).  
**Migrations clean replay:** https://github.com/e-proo/wacrm/actions/runs/43999534895 — **success**, including `openwa-deferred-recovery-smoke.sql`.  
**TEST migration:** `openwa_durable_identity_and_ack_recovery` applied through Supabase on `wacrm test`, version `20261117015956`. No Production migration attempted.

### 8.1 Implemented code

- `supabase/migrations/179_openwa_durable_identity_and_ack_recovery.sql` introduces `openwa_deferred_events`, a compact service-only ledger for signed but unresolved inbound native-LID events and unmatched ACK/status events. It pins the original linked phone identity and OpenWA instance, limits payload size, and supports unique signed event deduplication, lease tokens, retry bounds and review state.
- Transactional `defer_openwa_webhook_event` inserts or confirms the deferred record and marks the previously verified signed event receipt processed **in one database transaction**, preventing an unsafe 202-before-persistence response.
- `src/lib/whatsapp/transport/openwa/deferred.ts` runs identity preflight **before CRM/AI side effects**. It reuses the existing `resolveOpenWAInboundContactIdentity` with account/session-scoped on-demand `senderPhone` hydration and persists only minimal normalized business content (not raw webhook, decrypted keys, arbitrary provider metadata or inline media bytes).
- `src/app/api/whatsapp/openwa/webhook/route.ts` acknowledges a genuinely unresolved LID as `202 pending_identity` only after durable SQL commit. It likewise defers unmatched native ACKs as `202 pending_receipt`; failed durable saves still produce signed `503` retry. Normal verified inbound still enters the existing unified processor.
- `src/lib/whatsapp/transport/openwa/deferred-worker.ts` claims bounded jobs atomically, checks unchanged account+connection+session+own-phone+instance, re-resolves native LID proof, invokes the shared inbound pipeline, confirms non-reaction message persistence and settles with a compare-and-set lease. It never performs a blind outbound resend.
- `src/lib/whatsapp/status-lifecycle.ts` rejects webhook-level event IDs as message IDs and conditions message/recipient status writes on the observed prior state (compare-and-set), preventing late status downgrades in concurrent processing.
- TEST-protected `/api/internal/openwa-deferred-worker` is authenticated using `CRON_SECRET` and enabled in `npm run dev` only against the pinned TEST Supabase project; explicit opt-out is `WACRM_DEV_OPENWA_DEFERRED_WORKER=off`.
- `/api/whatsapp/connections/openwa/[connectionId]/reconciliation` exposes only admin-scoped safe state/diagnostics and TEST-only recheck of `review` items. The OpenWA Settings session panel includes the Arabic/English dashboard, without showing message content or identifiers.
- Added `deferred.test.ts`, `deferred-worker.test.ts`, revised webhook/status tests, and migration smoke. Meta remains the default and unchanged transport path.

### 8.2 Verified TEST evidence

- Existing TEST columns in `whatsapp_connections` and `whatsapp_webhook_event_receipts` match the migration's references.
- RLS is enabled on `openwa_deferred_events`; `anon` cannot SELECT and `authenticated` cannot INSERT or EXECUTE the worker claim RPC; `service_role` can use the table and worker RPC.
- Transactional TEST fixture (fully rolled back) validated: signed receipt row -> atomic deferred capture and receipt completion -> worker claim -> lease-token settlement; no fixture remained in the database.
- Latest project security advisor still reports known NOTE-001 security findings. `rls_enabled_no_policy` also flags this new server-only table, **intentionally**: browser table privileges were revoked, RLS is on, and no permissive policy exists. This INFO alone is not an exposure, but NOTE-001 must be assessed before production readiness.
- Current TEST account inventory has **no active OpenWA connection in ready/connected state** at the verification moment. Hence no fresh live `@lid` acceptance run or real provider ACK trace was possible during this implementation.

### 8.3 Explicitly NOT closed

- Upstream OpenWA host environment variable `RESOLVE_LID_TO_PHONE=true` still requires verification/enabling on the actual running gateway/container; GitHub WACRM code cannot change that external process configuration.
- Live acceptance from one new unsaved number, one saved number and an unknown-`@lid` sender, including delayed automatic recovery and full media/ACK lifecycle, remains **pending**.
- Previously failed signed receipts whose payload was not retained cannot be safely reconstructed from the existing receipt ledger. They require a newly signed event from the gateway or a verified read from the authenticated OpenWA archive; do **not** invent or infer phone/contents from old ledger IDs.
- Production rollout remains **NO-GO** pending the other OW-12/OW-13 evidence and NOTE-001 risk review.

**Closure classification:** **implementation complete + CI verified + TEST migration/transaction verified** for this engineering work package; **live acceptance incomplete** and **not production ready**.
