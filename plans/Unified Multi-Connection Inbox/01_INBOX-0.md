# INBOX-0 — Baseline & architecture contract (SOF-68)
Goal: freeze factual contracts before schema or runtime edits. Status Todo. Blocks INBOX-1.
## Work packages
### 0.1 Workspace inventory
- Recheck branch HEAD, read AGENTS.md, PROJECT_NOTES.md, OW master and Agent Task plan. Enumerate all paths reading/writing conversations/messages (including SQL functions/triggers, service role, API v1 and MCP, inbound webhook/echo, broadcast worker, manual/contact sends, task workers, automation/flows/AI, dashboard, notifications/deals, reactions/media).
- Pin migration 036, 037 dedup/unread RPC, 143/144 registry, 148 reservation, 150/151 native identity, 154 archive, 158+ task binding, 179/180 reconciliation, 195–204 security/review/activation; verify current latest numbered migration and TEST ledger. Do not assume branch == TEST.
- Capture current CI and TEST read-only aggregates: messages grouped by account/conversation/provider/connection; mixed threads, missing or mismatched registry IDs, historical no-message conversations, duplicate provider identity, unread counts, archived/ready sessions, reference counts. No customer text/numbers/native IDs exported; no mutations.
### 0.2 Architecture Decision Record
- Compare scoped read view vs materialized projection vs splitting conversations. Recommend additive inbox_threads since existing parent has unique account/contact and multiple downstream references. Select only after data/query evidence. Define identity, lifecycle on archived/recreated sessions, legacy unknown lane, same-phone recovery, read watermark, status vs CRM assignment/handoff, ownership of latest inbound and unread.
- Decide transactional maintenance strategy covering every inbound/outbound/echo writer, dedup and idempotency, monotonic summaries for delayed messages; define conflict with legacy unique(conversation_id,message_id) from 037 and safe additive remediation only if demonstrated.
- Define feature flag, old API compatibility, rollback, reconciliation, data conservation, least privilege and audit; draft API schemas, capability vocabulary and named negative cases.
### 0.3 Acceptance and design baseline
- Record screenshot/UX states on TEST if accessible; no new sends. Confirm desktop/mobile RTL/LTR and access roles; baseline API timings and synthetic fixtures, propose p95 budgets (see 06). Agree what all/one/historical/unknown scopes mean.
- Cross-check task frozen connection binding, public contracts and current OW14 security gates with Linear. Record open findings and risks.
## DoD
ADR reviewed, data contract and actual TEST aggregate/ledger evidence recorded, dependencies/writers mapped including SQL, rollback strategy and test matrix updated, CI baseline pinned. No unresolved critical architecture choice. No runtime changes and no live sends. Advance only after review.

## Gates مشتركة
- اقرأ HEAD والخطة ذات الصلة وAGENTS.md قبل التنفيذ؛ هذا المرجع مبني على 33e8e9af73d3de8c010ee291700fff7073abf520. التاريخ 2026-11-21.
- TEST فقط؛ لا تعديل Production ولا تشغيل إرسال حي بلا تفويض منفصل. لا تعديل migration قديمة، لا توسيع grants ولا تعطيل RLS أو guardrails لإمرار اختبار.
- سجل commit, CI run, migrations ledger, smoke output, risks, screenshots إن لزم. فرّق implementation complete / CI verified / TEST verified / live acceptance / production ready.
- لا إغلاق المهمة أو المرحلة قبل DoD المحدد؛ إذا كان CI قيد التشغيل فالبوابة مفتوحة.
