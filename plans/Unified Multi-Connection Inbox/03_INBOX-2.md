# INBOX-2 — Connection selector, list and realtime (SOF-70)
Depends INBOX-1. P0 UX functionality.
## 2.1 Connection catalog & selection
- Reuse/extract safe registry projection from broadcast/connections and whatsapp_connections; exclude secrets, gateway details and native IDs, role appropriate names/provider/status only. Display connected/ready by default, label readiness vs send policy (paused, restricted, activation, pilot). Historical/disconnected/archived accessible read-only; refresh safe metadata, admin-only active provider check.
- Default All active channels grouped by verified identity (explicit historical/unknown filter). Each item is a thread, not merged contact; same contact can appear once per verified channel. Show name, provider, last scoped preview/time, unread and status, assignment if applicable. Counts aggregated server-side for exact filter scope (no count of merely loaded page).
- Search name/phone/last preview within scope; deterministic filters (unread/open/pending/closed, mine/unassigned as supported, tags/company). Debounced search, bounded keyset pages and counts. Persist account-scoped preference, URL connection/thread; legacy ?c resolves to disambiguation where multiple threads. Switch clears old thread/draft display, cancels stale requests; no hidden draft send.
### 2.2 Thread history, reading and realtime
- Query only selected thread, scoped preview/history/reactions, paginate older messages; deduplicate optimistic against exact reservation/ID not blanket remove all temp rows. Preserve scroll anchor, cancel fetch on switch. Load omitted/unknown historical separately not unioned into selected sender.
- Use per-thread read watermark + atomic unread update; only current visible thread, no unread reset on background scope. CRM/global unread aggregates documented. Provider read synchronization to be completed in INBOX-3; notification read preserves assignment semantics and cannot clear unrelated connection notices.
- Refactor use-realtime/hydrate logic: account-safe scope, key by thread; coalesce and dedup events, reconnect/tab-visible refresh, update counts without injecting other connection rows, handle inserts/updates/deletes/archivals and out-of-order; manual refresh distinct from provider status.
## DoD
Fixture same contact on A/B of same verified number + Meta shows 2 threads (3 if A/B different numbers), only exact channel messages/preview/count in each; disconnected history visible read-only, legacy lane explicit. Rapid selection + delayed fetch + realtime, deep links, refresh, unread and paging verified. No accidental reads/sends. CI and TEST evidence.

## Gates مشتركة
- اقرأ HEAD والخطة ذات الصلة وAGENTS.md قبل التنفيذ؛ هذا المرجع مبني على 33e8e9af73d3de8c010ee291700fff7073abf520. التاريخ 2026-11-21.
- TEST فقط؛ لا تعديل Production ولا تشغيل إرسال حي بلا تفويض منفصل. لا تعديل migration قديمة، لا توسيع grants ولا تعطيل RLS أو guardrails لإمرار اختبار.
- سجل commit, CI run, migrations ledger, smoke output, risks, screenshots إن لزم. فرّق implementation complete / CI verified / TEST verified / live acceptance / production ready.
- لا إغلاق المهمة أو المرحلة قبل DoD المحدد؛ إذا كان CI قيد التشغيل فالبوابة مفتوحة.


## 2026-11-21 — Owner-approved channel identity amendment (normative)
[ADR-INBOX-002](14_INBOX0_CHANNEL_ADR.md) supersedes any earlier per-connection thread key or contradictory wording. Catalog groups verified number channels and expandable primary/secondary session diagnostics; All counts unique channels/threads, same-number session selector never duplicates history or unread. Exact session events for diagnostics only. Separate channels for different numbers/providers; historical archived session messages remain in active verified channel; archived channel read-only if no eligible member. Deep links use channel_id and thread; preserve exact sender context. Same contact OpenWA A/B same verified number + Meta => two threads (three only if OpenWA numbers differ).

## SOF-77 implementation checkpoint
218 adds bounded server-side search (contact + scoped preview), unread/status/assignment/tags/company filters and exact selected lane counts on the existing projection. Advanced filters and exact thread lookup bind into the signed cursor. Expected account/actor header is a mismatch fence, not an override. UI remains separately pinned TEST-only (WACRM_INBOX_READ_API=test_only AND WACRM_INBOX_SCOPED_UI=test_only), default off. Legacy page preserved unchanged as a separate component; no scoped view mounts the legacy writer. History/actions/realtime remain SOF-84/INBOX-3; no automatic mark-read or send in SOF-77. No production or flag activation.

SOF-77 client uses existing dashboard auth scope, exact server-side channel list and counts, safe diagnostics, account+actor-scoped device preference, explicit query state and candidate resolution. Keyed snapshots and AbortController prevent late fetches from older scope appearing. Only scoped preview/contact summary is displayed for selected row; SOF-84 owns actual history, mark-read, realtime and recovery. No legacy message/thread component mounted in gated UI. Supports RTL/LTR via logical spacing and all three catalogues. 
