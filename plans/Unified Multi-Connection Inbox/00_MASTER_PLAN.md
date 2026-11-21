# WACRM Unified Multi-Connection Inbox — Master implementation plan
**Status:** INBOX-0 evidence and technical ADR prepared; In Review, no runtime implementation. **Branch:** refactor/service-platform-v2. **Baseline:** [33e8e9a](https://github.com/e-proo/wacrm/commit/33e8e9af73d3de8c010ee291700fff7073abf520). [CI baseline](https://github.com/e-proo/wacrm/actions/runs/44800636849) completed/success (lint, typecheck, tests, build); not Inbox acceptance. [Linear P-SOF-3](https://linear.app/eproo/project/wacrm-unified-multi-connection-inbox-344a0ad3e1c1). 1,515 tracked files inventoried; relevant paths sampled/read, not exhaustive line-by-line audit. TEST mixed-data inventory executed; principal writer/reader and live SQL dependencies mapped; full source grep remains a phase gate.

## Product target
A single shared WACRM CRM with one contact and business conversation per account/contact, and separate operational threads per verified WhatsApp channel (several same-number OpenWA connections share one channel). All connections is a list of channel-scoped threads, never a merged sender. Selecting one channel shows its exact threads/messages, status, preview and read state. Ready/connected default options; archived/disconnected history remains accessible read-only via explicit historical filter; unresolved rows visible in a legacy lane with no inferred send eligibility. No silent cross-provider/session fallback. Meta retains default official status; OpenWA transport only. No new parallel CRM, WhatsApp sending engine or gateway.

## Current findings / impact map
| Current evidence | Impact / remedy |
|---|---|
| migration 036 unique(account_id,contact_id); inbound-processor.ts, resolve-conversation.ts and send route resolve by contact | preserve CRM identity, don't split parent conversations or repoint children blindly |
| migrations 143/144, 150/151 and 179/180; messages store provider, connection_id, provider_message_id and server-only native chat identity | use authoritative connection IDs, not phone/LID guesses; preserve identity and grants |
| conversation-list.tsx 98–101 and message-thread.tsx 385–388 fetch unbounded lists; client filters | keyset server scope + stable sort, bounded pages |
| inbox/page.tsx 175–212 uses whatsapp_config only; realtime hydration and deep link are conversation-only | unified safe catalog, thread-aware state, exact scope, account-level resync |
| message-thread.tsx 253–278 calculates universal 24h from latest customer and useMemo without timer; composer disables inputs | server-derived same-connection Meta policy and precise clock; OpenWA has separate readiness and safety policy |
| router.ts 35–41 uses latest customer connection or Meta default; send route 159–179 accepts explicit OpenWA only with same-phone verification | exact context for new Inbox routes; keep established contracts for legacy callers; no arbitrary sender switch |
| send-message.ts 21–29 validates provider/connection reply, rejects OpenWA template/interactive; idempotent reservation | reuse core and guardrails; stable request key; handle ambiguity and correlation |
| react route only supports Meta; OpenWA read route uses verified native inbound identity | capability gating and exact thread-scoped read; no cross-session acknowledgment |
| broadcast/connections route gives safe account-scoped registry; admin session GET exposes more operational metadata | reuse read-only contract or extract safe common projection; never expose admin/gateway credentials to operators |
| ai/tasks/outbound-message-connection.ts, reply-correlation.ts, task bindings 158–170, automations/meta-send.ts, flows/meta-send.ts, ai/auto-reply.ts and context.ts | keep frozen task sender and causal inbound context; audit legacy latest-inbound calls and AI history boundaries |
| public API v1 conversations and messages keyset API, notifications, contact sidebar, dashboard, deals | preserve IDs/shapes; any optional scope backward-compatible, not a breaking migration |

## Target contract
Canonical CRM: conversations.id, contacts.id, account_id. Operational key: (account_id, conversation_id, channel_id); provider derived from scoped registry and asserted against message provider. Prefer additive inbox_threads projection after ADR proves durable per-thread unread/status and efficient indexes (view only if all invariants demonstrably hold). A thread ID is opaque; require tenant checks and exact message identity. Unknown legacy connections remain explicitly unassigned; no sends or historical reassignment by guess. New writes preserve original messages and business refs. Same-phone recovery is an explicit authorized action, not a change of historical ownership. Thread state distinct from CRM assignment/handoff; decide ownership and aggregate semantics in ADR. No changes to agents/flows policy by accident.
API proposal: GET /api/inbox/connections; GET /api/inbox/threads?channel_id=&status=&search=&cursor=; GET /api/inbox/threads/{id}/messages?cursor=; POST /api/inbox/threads/{id}/read; eligibility/capabilities endpoint or thread response; explicit send context through existing send route/core. Names are proposed, reuse existing safe surfaces where feasible. Every query server-verified account/role; errors typed, no secrets. Deep links include thread/connection; legacy ?c= resolves without silent switch if multiple threads.

## Phase roadmap
| Phase | Linear | Gate |
|---|---|---|
| [INBOX-0](01_INBOX-0.md) | SOF-68 | ADR, inventory, TEST read-only baseline |
| [INBOX-1](02_INBOX-1.md) | SOF-69 | projection, migration/rollback, safe API |
| [INBOX-2](03_INBOX-2.md) | SOF-70 | scoped selector, realtime, read state |
| [INBOX-3](04_INBOX-3.md) | SOF-71 | sender isolation, provider policy + capabilities |
| [INBOX-4](05_INBOX-4.md) | SOF-72 | professional responsive design |
| [INBOX-5](06_INBOX-5.md) | SOF-73 | regression, performance, security, CI/TEST |
| [INBOX-6](07_INBOX-6.md) | SOF-74 | live TEST, rollout decision |
Phase gates sequential; work on UX mockups/tests may run in parallel, but no feature activation before INBOX-3/5 gates. See [acceptance & operations matrix](08_ACCEPTANCE_AND_ROLLOUT.md). Rollout: feature flag off by default; TEST opt-in, shadow compare counts/data, bounded pilot, explicit go/no-go. No GA if NOTE-001/OW-14/production gates remain; verify latest advisors (notes 2026-11-19 indicate auth leaked-password protection still open). No production change in this planning commit.

## Gates مشتركة
- اقرأ HEAD والخطة ذات الصلة وAGENTS.md قبل التنفيذ؛ هذا المرجع مبني على 33e8e9af73d3de8c010ee291700fff7073abf520. التاريخ 2026-11-21.
- TEST فقط؛ لا تعديل Production ولا تشغيل إرسال حي بلا تفويض منفصل. لا تعديل migration قديمة، لا توسيع grants ولا تعطيل RLS أو guardrails لإمرار اختبار.
- سجل commit, CI run, migrations ledger, smoke output, risks, screenshots إن لزم. فرّق implementation complete / CI verified / TEST verified / live acceptance / production ready.
- لا إغلاق المهمة أو المرحلة قبل DoD المحدد؛ إذا كان CI قيد التشغيل فالبوابة مفتوحة.

## 2026-11-21 INBOX-0 execution checkpoint
Technical ADR accepted; read-only TEST baseline verified (725 messages, 32 verified pairs, 5 mixed parents, 117 archived messages, 16 mixed-parent unallocated unread). [Baseline](09_INBOX0_TEST_BASELINE.md) · [dependency inventory](10_INBOX0_DEPENDENCY_INVENTORY.md) · [accepted ADR](11_INBOX0_ADR.md) · [reproducible SQL](12_INBOX0_READ_ONLY_BASELINE.sql). No runtime changes. SOF-68 remains In Review until exhaustive exact-ref reader/writer census and review; browser unavailable. SEC-INBOX-01 (broad grants/provider provenance) and DEP-INBOX-01 (204 not applied in TEST) tracked as prerequisites for activation; do not apply out-of-scope or bypass. New data model chosen: additive durable inbox_threads with exact per-connection scope, unallocated legacy unread bucket, trusted inbound provenance and transactional maintenance. No live/production acceptance.


## 2026-11-21 — Owner-approved channel identity amendment (normative)
[ADR-INBOX-002](14_INBOX0_CHANNEL_ADR.md) supersedes any earlier per-connection thread key or contradictory wording. Product target and Target contract **superseded for identity** by ADR-INBOX-002. One channel per verified account/provider/WhatsApp own identity; multiple OpenWA sessions same identity share one thread. Exact transport sender still pinned. API filter channel_id rather than connection_id for history, session diagnostic filter only.

## Exact-ref census evidence — 2026-11-21
[Full census and impact review](15_INBOX0_CENSUS_EVIDENCE.md): at `c8c30f0eb58569c91633258d58fb9ac5e50edaf9`, [census run 44937975928](https://github.com/e-proo/wacrm/actions/runs/44937975928) completed/success (1,297 files scanned, 393 candidate paths), [full CI 44937975891](https://github.com/e-proo/wacrm/actions/runs/44937975891) completed/success. Source census scan completeness verified, additional targeted code boundary review documented. Owner accepted ADR-002. No runtime/TEST changes. New documentation finalization CI must complete before formal phase closure. Dynamic/indirect affected caller verification and regression remain mandatory in INBOX-1/3. Conditional browser snapshot unavailable, deferred; not a runtime acceptance claim.
