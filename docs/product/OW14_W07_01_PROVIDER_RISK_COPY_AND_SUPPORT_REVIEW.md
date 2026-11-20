# OW14-W07-01 — Bilingual provider wording, disclosures and support review

**Status:** Product/Legal DRAFT, not approved terms or persisted opt-in.
**Draft policy ID/version:** openwa-linked-device-usage / ow14-w07-draft-2026-11-20-v1.
**Single UI copy source:** src/lib/whatsapp/transport/openwa/operational-policy-draft.ts.
**Surface:** Settings → WhatsApp → WhatsApp providers; read-only review modal and FAQs.
**Source contract:** docs/architecture/OW14_W07_00_PROVIDER_CONSENT_AND_ACTIVATION_CONTRACT.md.

## Product positioning

| Message | Arabic | English |
| --- | --- | --- |
| Meta | رسمي · الافتراضي | Official · Default |
| OpenWA | اختياري · غير رسمي | Optional · Unofficial |
| Preview | معاينة سياسة التشغيل | Operational policy preview |
| CTA | استعراض المخاطر والشروط | Review risks and terms |
| Owner consent | موافقة مالك الحساب (قيد التجهيز) | Account-owner acceptance (planned) |
| Per-session activation | تفعيل الاتصال المحدد (قيد التجهيز) | Enable a specific connection (planned) |

### Risk warning — Arabic draft

OpenWA تكامل اختياري ذاتي الاستضافة عبر جلسة WhatsApp Web لجهاز مرتبط، وليس واجهة Meta Cloud API الرسمية أو تكاملًا معتمدًا منها. قد تنقطع الجلسة أو تتطلب QR جديدًا وقد تتعرض للتقييد وفق سياسات WhatsApp. لا يمكن ضمان استمرارية الجلسة أو نجاح وصول كل رسالة. يجب احترام موافقات المستلمين، والأنظمة والسياسات ذات الصلة. أي رسالة انتهت مهلة إرسالها أو لم يُثبت وضعها يجب مراجعة أدلتها وتسويتها؛ لا يُعاد إرسالها عميانيًا.

### Risk warning — English draft

OpenWA is an optional self-hosted WhatsApp Web linked-device transport, not the official Meta Cloud API or an endorsed integration. Sessions may disconnect, require QR relinking, or become restricted under WhatsApp policies. Continuous availability and delivery cannot be guaranteed. Recipient permission, applicable laws and platform rules remain mandatory. Uncertain sends require evidence-based reconciliation, never blind retransmission.

### Account-owner acknowledgment — future wording only

**AR:** أقرّ أنني مالك هذا الحساب المخوّل، وراجعت النسخة المعتمدة من المخاطر والشروط المشار إلى رقم إصدارها. أفهم أن الموافقة لا تسمح بمراسلة مستلمين دون إذن، ولا تبدأ الإرسال، ولا تتجاوز ضوابط الأمان وموافقات الحملات.

**EN:** As an authorized account owner, I have reviewed the approved version of OpenWA usage risks and terms. Acceptance does not authorize unsolicited messages, initiate dispatch, or bypass safety controls and campaign approvals.

**Important:** No Accept, Activate, Save, or hidden auto-consent button must be wired until versioned backend acceptance with audit and security review is complete in W07-02..04. Existing TEST Pilot is a separate operational mechanism.

## UX guidelines

- A compact, accessible provider comparison precedes existing Meta/OpenWA configuration. No duplicated configuration form or parallel session manager.
- Two responsive cards explain official/default Meta versus optional/unofficial OpenWA. Link to existing settings sections with working anchors.
- One neutral preview status explains that this is not live consent. Avoid a false enabled/disabled badge implying an operational gate currently exists.
- A genuine review button opens an accessible keyboard-dismissable risk dialog; user only closes it, never consents. Show policy draft version without exposing secrets.
- The risk dialog contains five concise categories (unofficial integration, availability/QR, policies and recipients, timeout reconciliation, profile privacy). FAQs expand without server calls.
- Arabic RTL and English LTR. Use the existing app locale; ensure layout/mobile wrapping, focus-visible styles, labels and contrast. Avoid decorative buttons that do nothing.
- Product/Legal must review the translated copy side-by-side and record sign-off on a NEW immutable published version/digest, not reuse the draft ID.

## FAQ and support outcomes

1. **Provider choice:** No automatic Meta → OpenWA change. An admin explicitly chooses a verified eligible session; Meta remains default.
2. **Session disconnect:** Pause future sends, inspect the gateway, restore/relink only with admin authorization. Do not delete profiles or create duplicate sessions.
3. **Uncertain message:** Do not infer failure from a timeout; use operator reconciliation and native evidence, never blind resend.
4. **Recipient permission:** Accepting risk terms does not provide recipient consent or grant broad broadcast permission.
5. **Pilot limitations:** TEST Pilot readiness/disable is not Production approval. Real admission controls follow W07-02..04.

## Review and QA checklist

- [ ] Product owner approves positioning and operational risk clarity.
- [ ] Legal/compliance approves exact AR/EN wording against current WhatsApp terms and applicable jurisdictions.
- [ ] Security approves consent audit retention and QR/credential/privacy statements.
- [ ] Support owner approves troubleshooting and escalation playbook (W07-06).
- [ ] Tests verify localization completeness, draft status, roles proposal, and clear no-consent semantics.
- [ ] Mobile/keyboard/RTL visual inspection completed on local Windows.
- [ ] W07-02..04 DB/API/send-enforcement complete BEFORE any functional acceptance/activation UI is released.
- [ ] Later bounded TEST and live acceptance separately authorized; no VPS or Production modification during this draft work.

**External review references** (not endorsement or a substitute for Legal):
- https://whatsappbusiness.com/policy/
- https://www.whatsapp.com/legal/WhatsApp-Terms-for-WhatsApp-Business-App
- https://www.whatsapp.com/legal/business-solution-terms/

**Evidence level:** Draft copy + review UX prepared; not approved production terms and not an executable opt-in.
