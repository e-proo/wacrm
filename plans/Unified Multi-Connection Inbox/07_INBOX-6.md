# INBOX-6 — Live TEST acceptance and rollout (SOF-74)
Depends INBOX-5. Do not send real messages until operator authorizes exact TEST scope, sessions, recipients, limits and scenarios; existing test numbers not auto reused.
## 6.1 Controlled live acceptance
- Freeze current HEAD + TEST migration ledger + exact running build, current OpenWA gateway version/session statuses, Meta config and guardrails. Review pending queued jobs/worker behavior; isolate owned consenting TEST recipients, don't accidentally dispatch historic jobs.
- Execute matrix 08: Meta inbound/reply and approved template path outside 24h (use valid historical evidence rather than fake timestamps); OpenWA A/B, same customer across both and Meta, text/media/reply/read/ACK, wrong session reject, explicit same-phone recovery, archived history and reconnect. Unavailable providers are blockers, not synthetic passes. Confirm window and connection scoped counts/search/list/history, role restrictions, mobile/RTL. Ambiguous outcome reconcile, don't retry blindly.
- Validate existing worker/tasks/automation/broadcast in controlled scenarios only if approved, compare evidence against pre-change baseline; no production traffic. Record redacted message IDs, connection aliases, expected/actual, timestamps, screenshot/log references, pass/fail/blocked and defects.
### 6.2 Runbook & rollout
- Admin setup, connection readiness vs send permission, unknown legacy handling, provider pause, manual refresh, ambiguous status/reconciliation, same-phone recovery, diagnostics and support. Reconcile counts and event lag; document escalation/on-call and kill switch. Rollback disable new Inbox flag and restore proven old path without losing writes; verify data preservation and queued worker isolation; never reroute pending sends or replay webhooks blindly.
- Pilot cohort after TEST acceptance and explicit authorization; monitor per-connection delivery/error/latency/lag and audit; staged rollout decision with owners and stop thresholds. NOTE-001 and OW14 current security/consent/monitoring gates, provider acceptance and production approvals remain independent. No Production mutation without separate authorization.
## DoD
Signed/recorded live acceptance matrix (all required cases PASS or explicit NO-GO), sanitized evidence, defects resolved for release gates, runbook/rollback rehearsal and documented GO/NO-GO. Distinguish implementation complete, TEST verified, live acceptance complete, production ready. If any production blocker remains, release decision NO-GO even if Inbox TEST passes.

## Gates مشتركة
- اقرأ HEAD والخطة ذات الصلة وAGENTS.md قبل التنفيذ؛ هذا المرجع مبني على 33e8e9af73d3de8c010ee291700fff7073abf520. التاريخ 2026-11-21.
- TEST فقط؛ لا تعديل Production ولا تشغيل إرسال حي بلا تفويض منفصل. لا تعديل migration قديمة، لا توسيع grants ولا تعطيل RLS أو guardrails لإمرار اختبار.
- سجل commit, CI run, migrations ledger, smoke output, risks, screenshots إن لزم. فرّق implementation complete / CI verified / TEST verified / live acceptance / production ready.
- لا إغلاق المهمة أو المرحلة قبل DoD المحدد؛ إذا كان CI قيد التشغيل فالبوابة مفتوحة.
