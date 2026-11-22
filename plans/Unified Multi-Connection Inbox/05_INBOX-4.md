# INBOX-4 — Professional UX/UI (SOF-72)
Depends INBOX-3. Use existing design system (Tailwind, existing UI primitives, translations); no separate CRM theme or framework.
## 4.1 Workspace layout
- Desktop: list 320–380px responsive, main thread flexible, collapsible CRM panel (contact, company, tags, notes, deals, assignment and activities). Header shows Inbox title, refresh, compact connection switcher (All, names, provider, readiness, unread), search, status filter tabs, assignment/tags/company under filter control. Row: avatar, name, last scoped content/time, provider+session label, unread, meaningful state; stable sort and selected/focus styling. Differentiate same name across sessions without noisy badges.
- Thread header: contact and number, connection label, provider/readiness, status/assignment, menu/refresh; Meta-only expiry countdown; OpenWA sender readiness/blocked reason, safe recovery link inside details. No gateway host clutter. Keep historical thread visible without send controls. Composer: text, supported media/reply/quick reply and draft, Meta-only templates/interactive when applicable, AI draft only in scope, stateful send/disabled reason.
- Readable message bubbles, voice/media previews, timestamps, provider status (sending, sent, delivered, read, failed, uncertain where proven), no falsely definitive outcome. Accessible error messages and retry only proven safe. Avoid excessive banners, provider troubleshooting in expandable panel.
### 4.2 Interaction and responsive behavior
- Mobile: one pane list/thread, back retains filter and scroll, contact drawer accessible, sticky composer safe-area/keyboard, taps >=44px where possible. RTL logical margins/icons, Arabic/English/Korean translations, dark/light tokens, localized dates/numbers, long text/url, truncation tooltips, keyboard navigation, focus restoration and screen-reader labels.
- Per account+thread draft (memory or safe local policy approved in ADR, avoid shared-device persistence of private message content by default), unsent draft warning; error/offline/stale load, skeleton, empty states (no active connections vs no matching conversations), no wrong-thread optimistic state. Distinguish realtime disconnected from WhatsApp disconnected.
### 4.3 UX verification
- Review desktop 1440/1024 and mobile 390/360, light/dark RTL/LTR; fixture rows for all states, archived and unknown. Keyboard/accessibility smoke and visual screenshots; verify role gating, no regressions in contact sidebar. Use existing UI test harness or add minimal reproducible tests; no real outbound in this phase.
## DoD
Design review + screenshot evidence, keyboard and mobile walkthrough, translations complete, all state/error/empty/loading workflows predictable and no unsupported actions. CI/build success and TEST UI verification with non-live fixtures.

## Gates مشتركة
- اقرأ HEAD والخطة ذات الصلة وAGENTS.md قبل التنفيذ؛ هذا المرجع مبني على 33e8e9af73d3de8c010ee291700fff7073abf520. التاريخ 2026-11-21.
- TEST فقط؛ لا تعديل Production ولا تشغيل إرسال حي بلا تفويض منفصل. لا تعديل migration قديمة، لا توسيع grants ولا تعطيل RLS أو guardrails لإمرار اختبار.
- سجل commit, CI run, migrations ledger, smoke output, risks, screenshots إن لزم. فرّق implementation complete / CI verified / TEST verified / live acceptance / production ready.
- لا إغلاق المهمة أو المرحلة قبل DoD المحدد؛ إذا كان CI قيد التشغيل فالبوابة مفتوحة.


## 2026-11-21 — Owner-approved channel identity amendment (normative)
[ADR-INBOX-002](14_INBOX0_CHANNEL_ADR.md) supersedes any earlier per-connection thread key or contradictory wording. Show channel/number and session group (primary/secondary, status); history and counts independent of current physical session, composer explicitly selects valid sender; session diagnostic view separate. Draft persists across same-channel sender selection but revalidate capabilities and route. Warn identity mismatch/re-pair, unavailable primary, no auto switch.


## 2026-11-22 — SOF-79 / INBOX-4.01 implementation checkpoint

- Branch: `refactor/service-platform-v2`; desktop workspace implementation through `6e6b35a0e96a76896353c08ae12b8cb5d70fafdf`. Uses existing WACRM styling and `ContactSidebar` (authenticated account-scoped contact lookup; existing notes/tags/deals). No separate CRM or send engine.
- Added explicit in-thread verified primary/secondary connection picker, server-derived capabilities and expiry display, conservative Meta-only template/interactive/reaction controls, supported media upload/caption and quick replies, native read/reply/reaction actions tied to exact message membership, and status-only reconciliation after uncertain network results. A pending send freezes its UUID in sessionStorage without persisting contact, content, token or media URL. An explicit new thread only chooses an existing CRM contact, channel and verified connection; it opens no provider session and sends no message. Viewer cannot initiate the new-thread flow. Translations updated in Arabic, English and Korean.
- The original workspace already supplied scoped list, channel filtering, unread, search, history, WACRM-local read and realtime; additions preserve the original parent conversation and do not auto-merge same-number session history. Historical/unknown lanes remain read-only.
- **Code evidence:** Full CI [45019333205](https://github.com/e-proo/wacrm/actions/runs/45019333205) completed/success through the explicit new-thread UI and route unit tests. The final incremental viewer/reaction patch must pass the latest Full CI before claiming combined CI verification. No browser screenshots or user-approved visual review have been captured from this chat. Still required by SOF-79 DoD: desktop 1440/1024, RTL/LTR, light/dark, actual no-send fixture and interaction/a11y review. Absence of that evidence cannot be relabeled as an accepted visual gate.
- **Safety:** hosted TEST currently has zero active verified channel memberships and zero scoped threads, so the live UI cannot be accepted with a real dual-session channel yet. `WACRM_INBOX_ACTIONS` is not enabled; no live send or Production change. SOF-86 covers the subsequent mobile, accessibility and state refinement; do not claim INBOX-4 parent closed from this checkpoint.
