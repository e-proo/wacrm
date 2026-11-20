# OW14-W05 — OpenWA delivery, webhook and native ACK reliability: P0 audit

**Scope:** TEST P0/P1 code audit and read-only evidence. No Production authorization. No live WhatsApp send or OpenWA container/session change was made for this audit.

- **Tracking:** [SOF-52](https://linear.app/eproo/issue/SOF-52)
- **Source of truth:** `e-proo/wacrm`, `refactor/service-platform-v2`. Record final SHA/CI in Linear.
- **Prerequisites:** OW-12 live TEST acceptance, OW-13 bounded pilot and NOTE-001 security gates remain independent.

## 1. Verified existing contracts

| Area | Actual behavior / implementation | Verification |
| --- | --- | --- |
| Signed inbound | `verifyAndReserveOpenWAWebhook` verifies the linked session/HMAC, scopes connection, persists receipt keyed by connection + provider event ID and enforces a 90-second lease / compare-and-set reclaim | `src/lib/whatsapp/transport/openwa/webhook.ts` + `webhook.test.ts` |
| Duplicate signed event | Completed duplicates return 200 without a second CRM/AI side effect. Concurrent in-flight attempts return **503 `in_flight`**, with Retry-After 5s | `src/app/api/whatsapp/openwa/webhook/route.ts` + route tests |
| Intake failure | A transient receipt reservation/DB failure returns **503 `intake_unavailable`** with Retry-After; invalid signature 401, unknown session 404, malformed input 400. Response body contains no raw exception/credential | W05 intake fix, new route tests |
| Processing failure | Failed processing releases the lease, records only a bounded safe code, returns **503 `processing_retry`**, not successful acknowledgment | Same route + tests |
| Deferred LID/ACK | Unresolved native LID and unmatched ACK are inserted into `openwa_deferred_events`; signed receipt is completed atomically with durable capture, **then** handler returns 202 | Migration 179, `deferred.ts`, `deferred-worker.ts` and existing tests |
| Retry worker | Service-role TEST worker claims bounded batches with lease tokens, validates tenant/connection/session/instance, and uses exponential retry. No WhatsApp resend | `src/lib/whatsapp/transport/openwa/deferred-worker.ts` |
| Delivery state | Matches provider + connection + provider message ID and validates account ownership first; forward-only status changes and compare-and-set on stored status | `src/lib/whatsapp/status-lifecycle.ts` and tests |
| Ambiguous outbound | WACRM reserves outbound idempotency key before sending and never blind-resends an uncertain result. Gateway does **not** expose native lookup by idempotency key, so `reconcileOutbound` deliberately throws `ambiguous_outcome` | `src/lib/whatsapp/send-message.ts`, `openwa/client.ts`, `reconciliation-simulation.test.ts` |
| Media | OpenWA inbound image/video/audio/document uses bounded signed inline bytes or a bounded archive GET retry; provider IDs aren't exposed in public media paths. Deferred media has no inline base64 retained | `openwa/inbound-media.ts` and `webhook-media.ts` |

**Risk boundary:** `503` on a signed webhook is a request to redeliver the **same event**, not to send a new WhatsApp message. A provider timeout is **not** evidence that a physical send failed. No synthesized provider IDs, duplicate messages or speculative phone resolution.

## 2. TEST read-only inventory snapshot — 2026-11-19 23:18 UTC

Queries aggregated **counts/status only**, without recipient phone, session/JID, native ID, body, key or message content:

| Metric | Observed | Interpretation / action |
| --- | ---: | --- |
| OpenWA signed event receipts processed | 902 | Historical processed count in TEST; **not** independent provider delivery proof |
| OpenWA webhook receipts unprocessed | 8 | 5 with a safe processing error code (4 `connection_restricted`, 1 `retryable_provider_failure`), 3 incomplete/unknown. All observed older than 24 hours; legacy receipts may lack replay payloads |
| `openwa_deferred_events` `unmatched_status/pending` | 23 | All `native_message_not_found`, older than 1 hour; 11 older than 24h. A provider-native correlation check is required; do not auto-replay or auto-mark as failed |
| OpenWA messages created within last 14d, `sending` | 1 | Potential ambiguity requiring provider/native correlation, not blind resend |
| Other OpenWA message states in same 14d interval | `read=131`, `delivered=176`, `failed=33`, `sent=3` | Database states, not a live proof of all message outcomes |

Queries to reproduce (read-only, TEST only; restrict reporting to aggregated counts):

~~~sql
select event_kind, state, coalesce(last_error_code,'none') as safe_error_code,
       count(*) as count, min(created_at) as first_seen, max(created_at) as last_seen
from public.openwa_deferred_events
group by event_kind, state, coalesce(last_error_code,'none')
order by count desc;

select case when processed_at is not null then 'processed'
            when processing_error is not null then 'retry_pending'
            else 'in_flight_or_unfinished' end as state,
       count(*) as count
from public.whatsapp_webhook_event_receipts
where provider = 'openwa'
group by 1;
~~~

**Caveat:** A receipt can refer to an OpenWA-originated event not stored as a WACRM outbound message. These counts alone do **not** establish data loss, transport failure, provider duplication, or which Docker worker processed the events.

## 3. Bounded follow-up work for W05

1. **Read-only native correlation triage:** choose a small authorized TEST subset of the 23 pending unmatched ACKs; through scoped connection-admin reconciliation, compare exact provider message IDs with native OpenWA archive/state, stored WACRM messages and broadcast recipients. Do not expose IDs/phone in runbooks or Linear. Classify real match, unrelated own-sent, missing-provider proof, or session/instance mismatch. No arbitrary status mutation.
2. **Legacy signed receipt triage:** distinguish genuinely incomplete vs terminally stale receipts, assess gateway's *signed* redelivery/archive support. Never reconstruct event content from an event ID or overwrite the receipt without evidence.
3. **Race/timeout regression:** signed duplicate/lease competition, `in_flight` vs `processing_retry`, fast ACK arriving before outbound save, repeated read/delivered status, timeout after physical send, worker crash and safe re-claim. Include Meta negative regression and cross-tenant/connection rejection.
4. **Media matrix:** image/video/audio/document inbound and outbound, delayed archive availability, 404 read-only retries, large media refusal, stable provider native identity and sent/delivered/read lifecycle.
5. **Live TEST acceptance when explicitly approved:** one registered and one unregistered number, uncertain send plus native reconciliation, media and ACK proof from actual provider, no physical duplicate, no cross-account leak. Record timestamps and sanitized trace IDs in a private acceptance packet, not public logs.

**NO-GO:** any confirmed duplicate physical send, tenant bleed, credential leak, unbounded replay, or fabricated native correlation.

## 4. Evidence level

- W05 P0 source audit: recorded.
- W05 targeted signed-webhook intake hardening + unit tests: implemented; await exact-HEAD successful CI before marking CI verified.
- TEST snapshot: read-only observation only; no migration or live service impact.
- Full W05 `TEST verified`, `live acceptance complete` and `production ready`: **NOT claimed**.

Deferred external paging belongs to `PROJECT_NOTES.md` NOTE-019 / SOF-51, not this W05 critical path.

## 5. OW14-W05 P1 — safe local ACK correlation triage (implementation)

- The existing **session-admin-only** `GET /api/whatsapp/connections/openwa/[connectionId]/reconciliation` now inspects a **bounded 50-row sample** of deferred ACKs, extracting native provider IDs server-side exclusively. The WACRM message and broadcast-recipient lookups are **exact** on `provider='openwa' + connection_id + provider_message_id`; no cross-account/connection broad search, no fuzzy/time-based matching and no provider lookup endpoint invented.
- The browser receives only an `ack_correlation` **category**, e.g. `needs_native_review`, `candidate_outbound_message`, `candidate_broadcast_recipient`, `inbound_only`, `ambiguous_local_rows`. It never receives native IDs, phone numbers, message bodies, QR or credentials. The Settings reconciliation panel displays a sampled aggregate and individual safe badges. An exact local match is **not delivery proof**.
- The endpoint remains **GET-only** for correlation: no message status updates, no queue state changes, no physical sends or speculative replay. Existing separate TEST-only identity verification/recheck controls keep their authorization guards. Diagnostic backend failure responds HTTP 503 rather than silently returning an apparently healthy count.
- The sample is not the entire queue; do not treat sample totals as complete population counts.
- Pure classifier tests cover exact IDs, no match, mixed/duplicate records, inbound-only, unrecognized/null sender type; session API tests cover admin access, scoped message+recipient lookups and redaction.
- **Independent read-only TEST SQL check:** 23 pending unmatched ACKs, 0 exact matches in local outbound messages, 0 local inbound-only matches and 0 broadcast recipients as of 2026-11-20. Consequently all 23 need bounded **native/provider evidence review** before any conclusion; the application cannot automatically reconcile these from existing WACRM rows.
- Future live gateway archive/evidence reconciliation (same linked session/instance, exact native provider message identity) and formal case disposition **remain pending**. No blind resend or fabricated native lookup.


## 6. OW14-W05 P2 — OpenWA native archive evidence (operator-triggered; no auto settlement)

- Upstream verified on rmyndharis/OpenWA main: src/modules/message/message.controller.ts exposes GET /api/sessions/:sessionId/messages with exact messageId, direction=outgoing, limit=2, inlineMedia=false; message.service.ts queries the exact stored waMessageId in the session. Gateway archive is NOT WhatsApp delivery proof, and absence is NOT proof no send occurred.
- Existing session-admin reconciliation UI gains a manual Check OpenWA archive button on pending/review unmatched ACKs. New TEST-only server-side GET /api/whatsapp/connections/openwa/[connectionId]/reconciliation/[jobId]/native-evidence requires admin, UUIDs, scoped account+connection+deferred job, unchanged session_id, phone identity, instance ID, and ready current connection.
- Before reading archive, WACRM uses existing scoped encrypted credentials, verifies gateway session ID, connected/ready status and real own-phone identity. Mismatched or missing identity evidence is refused. Native message references longer than upstream 200-character limit, malformed or containing whitespace/control chars are not queried. No broad archive scan.
- Exact GET enforces direction=outgoing, limit=2, inlineMedia=false and bounded 7-second timeouts. Parser requires exactly one row with matching original native ID, session ID, outgoing direction, allowlisted store status; malformed/duplicate/inbound cases fail closed.
- Response contains only a fixed result code, allowlisted archive_status and explicit whatsapp_delivery_confirmed:false / outbound_resent:false; never phone, native ID, content, chat, QR, media, credentials, raw provider errors or raw upstream record. No DB status changes, no queue settlement and no outbound WhatsApp sends.
- Archive_outbound_found means a native stored outgoing row exists, NOT physical delivery. Not_in_gateway_archive is not proof a send never occurred; service outage/session mismatch must remain unresolved.
- Real VPS OpenWA version and actual API contract must be smoke-verified; no live provider probe, automatic disposition or clearing the 23 unmatched ACKs occurred here. Full W05 remains In Progress and Production NO-GO.

## 7. OW14-W05 terminal historical ACK disposition — TEST evidence (2026-11-20)

**Decision:** When a signed, deferred ACK has no reliable matched local outbound message or broadcast-recipient row, the project owner explicitly authorized terminal **operational uncertainty** in TEST. Do not fabricate delivery/failure, remove the original evidence, perform a blind resend, or infer provider transport outcome from a missing gateway archive.

**Code/migrations:** `supabase/migrations/202_openwa_ack_disposition.sql` adds `closed_unverified` and `closed_archive_observed` terminal states and disjoint disposition metadata, plus a PII-minimal, append-only `openwa_ack_disposition_audit`. `203_openwa_ack_audit_append_only_grants.sql` revokes Supabase's default `service_role` UPDATE/DELETE/TRUNCATE grants. The `SECURITY INVOKER` `close_openwa_unmatched_ack` RPC requires owner/admin membership and service-role-only EXECUTE; it enforces exact account+connection+non-leased matching and **refuses closure when an exact local message or broadcast recipient now exists**. Worker claims only pending/leased; no message status mutation, new physical send, or ambiguous-resend path. Closed rows have 180-day retention, with audit rows retained independently.

**Operator UI:** Explicit confirm-and-close (`close_unverified`) and provider-observed-only (`close_archive_observed`) actions on the existing reconciliation panel, authorized by `requireOpenWASessionAdmin`. The provider-observed action re-queries the linked OpenWA session/server-side using exact message ID and own-phone proof, not a browser-supplied 'found' flag. No proof or ambiguous result => no provider-observed closure. Gateway archive status remains historical storage evidence, **never** `whatsapp_delivery_confirmed=true`.

**Historical TEST-only operation:** After migration apply and transaction rollback-only security smoke, an explicitly owner-authorized one-time TEST SQL transaction selected exactly **23** old unmatched ACK rows belonging to **one account/one connection**, verifying none were leased, no exact local message or broadcast match existed, and preserving event bodies/provider refs in the deferred ledger. It atomically set `closed_unverified`, `disposition_source='owner_requested_test'`, `disposition_code='no_verified_evidence'`, and wrote exactly 23 minimal audit entries. Audit actor intentionally NULL (engineering execution authorized in this chat, **not an impersonation of the account user**). The state is NOT `completed`, `failed`, `delivered` or `sent`.

**Verified TEST post-operation:** `openwa_deferred_events` => `23 closed_unverified`; unmatched ACK `pending+leased+review => 0`; `openwa_ack_disposition_audit` => `23 owner_requested_test / no_verified_evidence`; all have `disposition_at` set. The existing OpenWA `messages` 14-day inventory remains `delivered 176`, `read 131`, `failed 33`, `sent 3`, `sending 1`. The `sending` item is independent and still requires the existing uncertain-outbound review route; it is NOT reconciled by these ACK closures.

**Evidence and DoD limits:** The PostgreSQL terminal disposition mechanism + TEST historical backlog reduction are **TEST verified**. This does not prove native gateway archive correlation for any historic ACK, that no physical duplicate happened in a live resend scenario, Meta live parity, or comprehensive image/video/audio/document TEST acceptance. Do NOT close SOF-52 or claim W05 live acceptance / production readiness until its explicit DoD is met. It is permissible to continue **W06 capacity, backup and restore preparation in parallel**.

## 8. Admin bulk disposition from Settings UI (P3 usability hardening)

- **Confirmed UI route:** Settings > WhatsApp > OpenWA connection > Identity & delivery reconciliation. An authorized session admin can view the scoped status/ACK list, inspect a native OpenWA archive entry, close an individual unmatched ACK as `closed_unverified`, or record verified presence of a native outgoing archive row (`closed_archive_observed`). All record the real signed-in admin actor; no message status or physical send is changed.
- **New batch UX:** Explicit checkbox selection of currently visible `pending`/`review` *unmatched_status* rows, select up to 25 per attempt, and **Close selected as unverified** with a confirmation that results can be partial. The server endpoint is `POST /api/whatsapp/connections/openwa/[connectionId]/reconciliation/bulk-disposition`, TEST-only and `requireOpenWASessionAdmin` protected. It rejects missing opt-in, bad or repeated IDs, non-TEST and over-limit batches. Each item calls the same `close_openwa_unmatched_ack` invoker RPC with exact authenticated actor+account+connection and `confirm_no_resend=true`.
- **Partial results are explicit:** Exactly one idempotency-fenced, locked RPC per selected job, in batches of five concurrent reads/writes maximum; each transaction independently records audit or reports non-closure (local match, lease, already closed, actor denied, temporary database error). The browser gets only the selected job UUIDs, safe result codes, aggregate closed/not-closed counts and repeated `delivery_confirmed=false`, `outbound_resent=false`. No raw native identifiers, session credentials, recipient phone or chat messages returned. The operator is warned about partial outcomes; failed selections remain available for review.
- **Closed-state evidence in UI:** A read-only sample shows safe terminal state, source (`admin_review` or earlier `owner_requested_test`) and closure time. No impersonation of earlier bulk engineering operation.
- **Limitations:** This is a bounded UI action, not a global or infinite `close all`. Database may refuse stale, re-leased or newly locally matched events; a failed batch cannot assume all work rolled back. It does not perform provider/archive confirmation for every batch row, so **the batch action is only `closed_unverified`**, never bulk `closed_archive_observed` or `delivered`.
- **Verification:** Route negative tests (non-TEST, unauthorized, malformed/duplicate/over-25 IDs, absent no-resend acknowledgement), 23-case batch mock preserving account and actor, partial outcomes and error redaction. New UI requires Hostinger app rebuild/deploy to become available; do not claim browser acceptance before that evidence.
