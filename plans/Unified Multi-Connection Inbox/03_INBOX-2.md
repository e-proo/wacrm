# INBOX-2 — Connection selector, list and realtime (SOF-70)
Depends INBOX-1. P0 UX functionality.
## 2.1 Connection catalog & selection
- Reuse/extract safe registry projection from broadcast/connections and whatsapp_connections; exclude secrets, gateway details and native IDs, role appropriate names/provider/status only. Display connected/ready by default, label readiness vs send policy (paused, restricted, activation, pilot). Historical/disconnected/archived accessible read-only; refresh safe metadata, admin-only active provider check.
- Default All active connections (explicit historical/unknown filter). Each item is a thread, not merged contact; same contact can appear once per connection. Show name, provider, last scoped preview/time, unread and status, assignment if applicable. Counts aggregated server-side for exact filter scope (no count of merely loaded page).
- Search name/phone/last preview within scope; deterministic filters (unread/open/pending/closed, mine/unassigned as supported, tags/company). Debounced search, bounded keyset pages and counts. Persist account-scoped preference, URL connection/thread; legacy ?c resolves to disambiguation where multiple threads. Switch clears old thread/draft display, cancels stale requests; no hidden draft send.
### 2.2 Thread history, reading and realtime
- Query only selected thread, scoped preview/history/reactions, paginate older messages; deduplicate optimistic against exact reservation/ID not blanket remove all temp rows. Preserve scroll anchor, cancel fetch on switch. Load omitted/unknown historical separately not unioned into selected sender.
- Use per-thread read watermark + atomic unread update; only current visible thread, no unread reset on background scope. CRM/global unread aggregates documented. Provider read synchronization to be completed in INBOX-3; notification read preserves assignment semantics and cannot clear unrelated connection notices.
- Refactor use-realtime/hydrate logic: account-safe scope, key by thread; coalesce and dedup events, reconnect/tab-visible refresh, update counts without injecting other connection rows, handle inserts/updates/deletes/archivals and out-of-order; manual refresh distinct from provider status.
## DoD
Fixture same contact on A/B/Meta shows 3 threads in all, only exact messages/preview/count in each; disconnected history visible read-only, legacy lane explicit. Rapid selection + delayed fetch + realtime, deep links, refresh, unread and paging verified. No accidental reads/sends. CI and TEST evidence.

## Gates مشتركة
- اقرأ HEAD والخطة ذات الصلة وAGENTS.md قبل التنفيذ؛ هذا المرجع مبني على 33e8e9af73d3de8c010ee291700fff7073abf520. التاريخ 2026-11-21.
- TEST فقط؛ لا تعديل Production ولا تشغيل إرسال حي بلا تفويض منفصل. لا تعديل migration قديمة، لا توسيع grants ولا تعطيل RLS أو guardrails لإمرار اختبار.
- سجل commit, CI run, migrations ledger, smoke output, risks, screenshots إن لزم. فرّق implementation complete / CI verified / TEST verified / live acceptance / production ready.
- لا إغلاق المهمة أو المرحلة قبل DoD المحدد؛ إذا كان CI قيد التشغيل فالبوابة مفتوحة.
