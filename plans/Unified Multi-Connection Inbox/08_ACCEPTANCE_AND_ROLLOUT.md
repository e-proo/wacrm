# Acceptance matrix & operational release checklist
Status: planned, no tests executed for this new feature. Technical tests first, live cases last. Use fixture data, rollback transactions, authorized owned numbers for live only. Evidence per row: baseline HEAD, environment, role, alias of connection, test case, expected/actual, PASS/FAIL/BLOCKED, log/test/CI reference, sanitized evidence, issue.
| ID | Scenario | Required result | Gate |
|---|---|---|---|
| A01 | same contact Meta, OW-A, OW-B | two channel threads if OW A/B share verified identity; three if different; one CRM contact; no mixed channel previews/history | 1/2 |
| A02 | outbound-only verified thread | explicit connection, no default to wrong provider | 1/3 |
| A03 | null/mismatched/archived legacy identity | historical or unknown read-only, no guessed route; count conservation | 1 |
| A04 | cross-tenant UUID / read / cursor / send / attachment | denied, zero leaked data and provider calls | 1/3/5 |
| A05 | duplicate/out-of-order inbound/echo and ACK | one message, monotonic preview, correct status/count | 1/2/5 |
| A06 | read one of same-contact threads, background event | only intended thread unread cleared, correct totals | 2/3 |
| A07 | rapid switch, stale fetch, realtime reconnect, paging | no other-thread messages, no duplication, restored selection | 2/5 |
| A08 | Meta open/expired/no inbound at exact 24h | free text only valid window, approved template path, server recheck | 3 |
| A09 | OpenWA old/no recent inbound with approved candidate | no Meta timer; text/media subject to OpenWA policy and identity | 3 |
| A10 | unrelated inbound from another connection | never opens Meta window or changes sender in active thread | 3 |
| A11 | Meta/OpenWA capability controls and reply/reaction | correct tools; cross provider/connection reply rejected | 3 |
| A12 | paused/pilot/consent/cap/restricted/disconnected | precise block, no dispatch; no provider fallback | 3 |
| A13 | stale selected sender, same-phone recovery | stale rejected, explicit authorized recovery, old history unchanged | 3 |
| A14 | repeat submit, timeout, late ACK/echo | identical key no duplicate, ambiguous stays uncertain until evidence | 3/5 |
| A15 | exact per-thread provider read and media | verified native route; no cross-session read, upload preserved on uncertainty | 3/6 |
| A16 | AI/flows/tasks/broadcast same contact mixed signals | causal/bound connection preserved, no approvals/caps changes | 3/5/6 |
| A17 | contact/notification/deal/API v1/MCP legacy | no breaking shapes/IDs, correct links and read assignment | 2/5 |
| A18 | mobile RTL/LTR, keyboard, themes, empty/error | responsive accessible and localized | 4 |
| A19 | load, tenant RLS/grants, clean replay, rollback | budgets measured, data preserved, no secret exposure | 5 |
| L01 | authorized live Meta and OpenWA A/B same customer | actual inbound/outbound/status/visibility correct | 6 |
| L02 | authorized live text/media/reply/read/ACK and reconnect | correct provider, receipt reconciliation, no duplicates | 6 |
| L03 | authorized Meta outside window and OpenWA old chat | correct policy and real delivery evidence where allowed | 6 |
| L04 | bounded live regression/worker coexistence | no accidental dispatch, task/automation/broadcast correct | 6 |
## Cutover and backout
1. Freeze build/ledger, backup strategy, flag default off. Deploy additive schema to TEST after clean replay, shadow counts and verify no mismatches.
2. Enable for TEST users only after INBOX-3+5, then perform live acceptance on explicitly approved scope. Pause rollout on unexplained count discrepancy, wrong sender/tenant, duplicate outbound, policy bypass, stale leakage, or security issue.
3. Disable feature flag on incident; original CRM/messages stay authoritative and retained. Never blindly retry uncertain sends. Diagnose and reconcile projection using safe scoped replay without provider effects. Record operational audit. If schema rollback needed, plan additive forward fix instead of dropping data.
4. Production requires explicit GO with current NOTE-001, OW14, advisors/consent and provider risk reviewed, migration rehearsal, on-call owner, thresholds and rollback tested. Pilot limited to approved cohorts before gradual rollout. No dates or approval assumed.

## Gates مشتركة
- اقرأ HEAD والخطة ذات الصلة وAGENTS.md قبل التنفيذ؛ هذا المرجع مبني على 33e8e9af73d3de8c010ee291700fff7073abf520. التاريخ 2026-11-21.
- TEST فقط؛ لا تعديل Production ولا تشغيل إرسال حي بلا تفويض منفصل. لا تعديل migration قديمة، لا توسيع grants ولا تعطيل RLS أو guardrails لإمرار اختبار.
- سجل commit, CI run, migrations ledger, smoke output, risks, screenshots إن لزم. فرّق implementation complete / CI verified / TEST verified / live acceptance / production ready.
- لا إغلاق المهمة أو المرحلة قبل DoD المحدد؛ إذا كان CI قيد التشغيل فالبوابة مفتوحة.

## INBOX-0 additional negative gates (no PASS claimed)
- A24: single-scope inherited unread and mixed legacy unallocated count preserved, late inbound after read watermark, explicit legacy acknowledgment audit; no sibling clearing.
- A25: actual role grants, no unnecessary TRUNCATE/unsafe privileges, browser cannot forge trusted customer/provider/time/connection or bypass API; tenant FKs and RLS negatives, synthetic rollback tests only.
- A26: migration 204 ledger/schema and correct authorized W07 mode verified; legacy TEST mode never cited as activation/consent readiness. Archived ready not eligible, unknown native ID not guessed. 
- A27: immutable provider/connection binding, existing legacy unique collision and exact reply/echo/ACK dedup; no changes to external CRM IDs, no synthesized broadcasts.
- A28: explicit outbound-only thread and stale sender no latest-inbound/Meta fallback; no partner/CRM action leakage.


## 2026-11-21 — Owner-approved channel identity amendment (normative)
[ADR-INBOX-002](14_INBOX0_CHANNEL_ADR.md) supersedes any earlier per-connection thread key or contradictory wording. A01 same contact Meta and two OpenWA sessions of same verified number => two channel threads, one CRM parent; if different OpenWA numbers three threads. A06 channel read clears only same channel; A10 other channel inbound cannot open Meta window. Add cases below.

| ID | Additional mandatory case | Expected | Gate |
|---|---|---|---|
| A29 | two verified sessions same number, concurrent duplicate native event | one logical message, thread, unread and idempotent fanout; two authenticated observations (when actually delivered) | 1/2/5 |
| A30 | same native ID on different verified channels; same body on distinct strong IDs | never collapse different messages/channels; scoped dedup | 1/5 |
| A31 | event-only ID or different engine aliases without proof | durable unresolved/review; no guessed merge, auto-response or replay | 1/3/5 |
| A32 | session replacement/re-pair different number or stale identity | stable verified same channel history; different identity new epoch/channel; no history remap | 1/2/3 |
| A33 | selected secondary, stale primary and ambiguous outbound | explicit eligible exact session; frozen intent/epoch; no blind resend or silent fallback | 3/5 |
| A34 | switch session to bypass consent/cap, forged cross-account membership | deny; aggregate channel caps and scoped authorization | 3/5 |
| A35 | same channel read/ACK/reply with native identity missing | CRM read once; provider action only proven exact route, no sibling channel effects | 3/5 |
| L05 | owned same number with two ready sessions and second distinct channel | actual native ID/receipt behavior confirmed, one canonical effect, separate other channel; no fake pass if unavailable | 6 |
