# OW14-W07-06 — OpenWA support, incident response and operator procedures

**Project:** WACRM · WhatsApp Multi-Provider/OpenWA  
**Branch:** refactor/service-platform-v2  
**Date:** 2026-11-20  
**Tracking:** SOF-54 / W07-06  
**Scope:** Windows-first help center and human-operated support. Not Production GO, gateway redesign, an external ticketing backend, or live acceptance.

## 1. Help center and user experience

The WACRM admin UI now includes **Settings → WhatsApp → Help & procedures**, a seventh top-level tab alongside Overview, Meta, Sessions, TEST Pilot, Consent & Audit and Delivery Review.

Four functional panels:
1. **Troubleshooting:** searchable/filterable Arabic/English incidents; severity P0..P3; role ownership; human-only checklist; unsafe actions; escalation target; navigation to an existing management tab.
2. **Operating procedures:** detailed accordions for session onboarding, consent, STOP/containment, relink, outbound ACK/LID reconciliation, TEST Pilot, support handoff and Production prerequisites.
3. **Safe diagnostics:** explicit admin-click, two read-only requests to existing account-scoped WACRM GET APIs; safe synthesized status and sanitized clipboard report; NEVER an external ticket or a provider send.
4. **FAQ:** bilingual clarification of official/default Meta, optional/unofficial OpenWA, QR privacy, legal consent, unknown message outcomes and deferred W06 recovery.

These procedures are GUIDANCE, not automatic operations. Checking boxes is transient browser-only state, not server audit. The Help section never calls sending, session-creation, worker, approval, or provider POST APIs. Deep-link buttons switch to existing authenticated tabs; the operator must separately confirm any sensitive action.

Help articles may be viewed by any user with settings read access. Admin/owner-only diagnostics and management are role-gated in the UI and independently enforced by existing server requireRole / tenant-scoped SQL RLS/RPC checks. Agents cannot read secrets or choose the OpenWA transport engine.

## 2. Ownership and escalation responsibilities

| Area | Responder | Decision owner | Safe action | Forbidden |
| --- | --- | --- | --- | --- |
| Meta setup | Account Admin | Official API owner | Authorized Meta connection check, server-side credentials validation | Silent fallback to OpenWA |
| OpenWA session/QR | Admin | Operations | STOP where needed, existing-session reconnect, short-lived QR for admin | Share QR/profile/key; duplicate session on uncertain create |
| Policy consent | Account Owner | Product/Legal + Owner | Review signed AR/EN legal text and explicitly accept/revoke | Admin impersonates owner; accepts draft |
| Per-session activation | Admin/Owner | Account Owner + Operations | Enable/suspend/disable ONLY under W07 server gates | Treat requested enable as sending authorization |
| Ambiguous outbound / ACK / media | Delivery operator Admin | Delivery Engineering | Native evidence, no-resend audited disposition where supported | Blind resend or guessed delivery |
| Inbound @lid | Integration Admin | Gateway/Identity | Verify phone pairing via native proof then unified pipeline | Invent digits from LID |
| Webhook/signature failures | Operations | Gateway + Security | Check HMAC/replay/dedup/deferred state | Disable HMAC/RLS |
| Duplicate workers or leaked keys | Incident Commander | Security + Operations | Immediate containment, evidence preservation, approved credential rotation | Leave two workers on one TEST queue; expose secrets |
| Production rollout | Product/Legal/Security/QA/Ops | W09 GO/NO-GO owner | Independent checklist and sign-off | Turn on release flag based only on green CI |

## 3. Severity and triage rubric

- **P0 Critical:** credential/tenant exposure, two workers sending from the same TEST queue. Immediate containment and Security + Operations incident commander escalation.
- **P1 High:** widespread ambiguous sends, provider restriction, webhook failure, replay/dedup risk. STOP if unsafe, preserve native correlation and escalate to Delivery/Gateway/Security.
- **P2 Medium:** disconnected session, missing migration 204, outdated consent, unmatched ACK, unresolved LID, uncertain media. Inspect precise connection; follow operator procedure with auditable evidence.
- **P3 Low:** known TEST Pilot cap, informational status or FAQ. Explain constraints and use existing administrative controls only if authorized.

There is **no committed SLA, RTO or RPO**. W06 backup/restore remains deferred; do not advertise proven restore before an isolated recovery exercise.

### Mandatory first responder sequence

1. Determine which environment is affected (Windows local TEST, independent VPS TEST or separately approved Production). Do not assume that stopping a Windows process stops VPS schedulers.
2. Confirm account and connection via the existing privileged UI, without copying their identifiers into the public support report. Identify owner, symptom category and severity.
3. Run the Help read-only diagnostic ONLY if authorized, or request one from Admin. A 503/403/404/invalid response is **unknown/unavailable**; it must never be rendered as zero connections or a successful state.
4. Decide containment versus native-evidence review. For P0/P1, STOP or suspend exact outbound scope as appropriate, using existing management UI with server authorization.
5. Assign an internal incident reference through the team's approved communication channel; no ticket is automatically created by this UI.

## 4. Read-only diagnostic contract and evidence policy

The operator presses **Check current state**. The browser makes two independent same-origin, authenticated no-store GET requests, with a bounded 12-second abort:
- /api/whatsapp/connections/openwa/operational-policy — current approved policy, owner consent, requested activations and safe denial reasons.
- /api/whatsapp/connections/openwa — current session metadata, emergency pause flags and account-level outbound review totals.

The second existing API includes privileged session metadata in browser memory. The report only extracts allowlisted **aggregates**; it never serializes the original server response. No background polling, no writes, no send retries. On account/role change the previous diagnostic is aborted/cleared. Clipboard copy happens only from a user click.

Safe report schema **w07-support-v1**:
- local UTC check timestamp; literal source read enums (ok/unauthorized/forbidden/unavailable/invalid);
- W07 gate mode (legacy_test/enforce_test/enforce_release/unknown), current-policy approved flag, current consent boolean and non-TEST release configuration state;
- numeric counts: all sessions, ready sessions, activation requested, manually paused, outbound unreviewed;
- boolean count consistency of the two reads;
- counts for fixed, whitelisted W07 reason codes and predefined human support procedure IDs.

**Explicitly excluded:** account ID, actor ID, session/connection ID, native message ID, ACK ID, phone, LID/JID, recipient, message/media content, gateway origin/URL, QR, credentials, HMAC, access tokens, SQL/JS error text, cookies, client IP, raw audit rows and raw provider payload.

A successful admin GET **does not** prove provider reachability, permission to send, recipient consent or delivery. Session ready != authorized; requested activation enabled != authorized. TEST Pilot != Production consent. Only the W07-04 pre-dispatch and final adapter gate authorize each actual OpenWA send along with independent recipient/policy/STOP safeguards.

Use the **Copy sanitized handoff** button to copy only the approved summary and send it manually through a trusted internal support channel. The UI deliberately has NO auto-submission to external services. Never ask clients to provide QR/keys/JID.

## 5. Incident decision matrix

| Symptom | First action | Evidence and next step | Prohibition |
| --- | --- | --- | --- |
| disconnected / reconnecting | Review exact session and STOP new sends if needed | Gateway reachability → refresh → same-session reconnect → review uncertain queue | No duplicate create after timeout |
| waiting_qr / logged_out | Confirm Admin and session identity | New admin-only short-lived QR → status + webhook check | No QR screenshot in support |
| policy_not_approved | Keep accept blocked | Product/Legal signed bilingual immutable wording and matching DB policy digest | No draft acceptance or server flag bypass |
| consent_required / outdated / changed | Inspect owner consent/audit | Owner reaccepts actual approved terms; admin explicitly reactivates same connection | No automated reacceptance |
| connection disabled/suspended | Respect current containment | Review reason and permissions before manual reenable | No bypass via Pilot or session Ready |
| control_unavailable / HTTP 503 | Treat state as unknown | Verify TEST migration 204 and admin permissions with redacted logs | Do not weaken RLS/expose service role |
| connection_restricted | STOP if unsafe; review provider/policy | Check platform restriction and permission, escalate | No automatic provider switching or repeated sends |
| ambiguous_outcome / timeout | Preserve original idempotency and pending evidence | Outbound review → native proof → audited disposition | **Never blind resend**; do not mark delivered/failed |
| unmatched_status ACK | Select single connection | Native evidence, event identity correlation, safe closure where supported | No manufactured delivery confirmation |
| unresolved_identity / @lid | Preserve unresolved identity | Native gateway phone pairing proof then unified inbound pipeline | No phone guessed from LID |
| media unknown | Keep result unknown | Correlate original provider media ID and ACK | No automatic reupload or retry |
| webhook 401/404/503 | Check configured route/signature | HMAC, replay protection, dedup/lease backlog and redacted errors | No disabling webhook verification |
| TEST daily/hourly cap | Inspect exact TEST Pilot/cohort/caps | Admin-reviewed TEST change only if authorized | Do not disable production anti-abuse |
| Windows and VPS workers overlap | P0 contain duplicate job owner | Verify both runtimes and reconcile prior reservations | No concurrent scheduler against same TEST DB |
| suspected leaked key/tenant crossing | P0 stop/contain and alert Security | Scoped rotation/RLS investigation with preserved evidence | No raw secrets in support or broad service_role |
| Meta official API failure | Isolate Meta config | Authorized Meta credential/registration check | No silent OpenWA fallback |

All scenarios correspond to the **versioned, bilingual** in-app catalogue at src/lib/whatsapp/transport/openwa/support-playbooks.ts. Support guidance is not evidence of incident recovery.

## 6. Important human-operated workflows

### A. Emergency STOP and worker containment
- Identify exact affected account, connection and worker environment. Do not send to an unverified recipient or reuse credentials.
- Use the existing per-connection STOP/suspend where your role permits. A browser being closed does NOT stop a VPS scheduler.
- Confirm Windows worker and independent VPS scheduler status through their authorized respective runtime controls; do not resume both against one queue.
- Preserve provider idempotency keys and unreviewed queue items. Do NOT delete profiles, raw logs needed for forensic review, or queue rows as a shortcut.
- Re-enable only after independent approval, evidence review and recipient/consent checks.

### B. Uncertain-send or ACK reconciliation
- Open the **Delivery Review** tab. The account-wide card summarizes all current and future sessions without duplicate alerts per session.
- Select the affected connection; distinguish unknown outbound, unmatched status and unresolved inbound identity. Use native evidence where possible.
- If native delivery proof is absent, use only supported audited **closed_unverified** administrative closure (not a delivered/failed assertion). No automatic resend.
- For LID, verified phone mapping is a prerequisite to reprocessing via the WACRM unified inbound pipeline; never infer digits.

### C. Reconnect/relink session
- Verify that a prior remote create attempt has not already succeeded before creating anything new.
- Use existing session's refresh/reconnect and privileged QR workflow. No sharing QR or API key in tickets.
- Verify gateway/webhook and ready state separately from owner consent and TEST Pilot.
- Audit previous uncertain messages; new connection readiness cannot retroactively prove delivery.

### D. Customer-facing support wording (operator-reviewed, never auto-sent)

**Arabic:** راجعنا حالة الاتصال من أدوات WACRM المصرح بها، وما زالت نتيجة الحالة بحاجة إلى تحقق. لن نعيد إرسال رسالة غير مؤكدة تلقائيًا. سيُراجع المسؤول المختص حالة الجلسة أو الموافقة أو أدلة التسوية قبل الإجراء التالي. لا نحتاج رمز QR أو مفتاح API أو محتوى الرسالة.

**English:** The authorized WACRM read-only checks indicate that this state still needs verification. We will not blindly resend an unconfirmed message. An authorized operator will review the relevant connection, consent or reconciliation evidence before the next action. Please do not share QR, API keys or message content.

## 7. W07-07 handoff and Production prerequisites

**W07-06 technical acceptance checklist (do not pre-check before CI):**
- [ ] Exact-HEAD CI completed/success for lint, TypeScript, Vitest, Meta/OW-4 regression, Next production Build.
- [ ] Catalog has unique procedure IDs, 3+ human steps each, complete AR/EN, severity/owner/escalation/never-do.
- [ ] Diagnostic sanitizer cannot leak injected credentials, URLs, phone numbers, account/session identifiers, audit actors or raw errors.
- [ ] Missing/403/503/malformed API never becomes zero sessions/authorized; zero send/write endpoints called by Help.
- [ ] Seven top-level tabs, four help panels, role-gated explicit diagnostics; correct tab deep links.
- [ ] No schema change, hosted TEST DB, VPS/Production or live provider send in this stage.

**Separate operational acceptance not proven by code:**
- [ ] Operations/Support owner tabletop: P0 duplicate workers/credential leak, P1 ambiguous outcome/webhook, P2 QR/consent/ACK/LID.
- [ ] Security review of browser clipboard scope, account-switch abort and privileged endpoint RBAC.
- [ ] Product/Legal approval of legal terms before actual owner acceptance; the current draft is not approved.
- [ ] Human Windows RTL/mobile/English/keyboard/screen reader review and screenshot evidence.
- [ ] W07-07 full regression before separately authorized W07-08 TEST acceptance.
- [ ] Before Production: W06 isolated restore and backups, W08 release evidence, NOTE-001 debt, W09 GO/NO-GO, current Meta compatibility and live acceptance evidence.

**Never claim:** implementation complete implies hosted TEST verified, customer policy signed, backup recovery proven, live delivery accepted or Production ready.
