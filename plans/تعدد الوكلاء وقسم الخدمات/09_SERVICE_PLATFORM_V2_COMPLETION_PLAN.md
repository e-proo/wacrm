# WACRM — Service Platform V2 Completion Plan

## 1. هوية الوثيقة

- **Repository:** `e-proo/wacrm`
- **Implementation Branch:** `refactor/service-platform-v2`
- **Parent architecture:** `08_SERVICE_PLATFORM_ARCHITECTURE_AND_TRANSITION_V2.md`
- **Baseline عند إنشاء هذه الوثيقة:** migrations حتى `106_coverage_business_event_controlled_cutover.sql`
- **الهدف:** إغلاق الفجوات المتبقية بعد بناء Service Platform V2 وتحويلها من refactor متقدم إلى منصة مكتملة وقابلة للاعتماد كمرجع للخدمات الجديدة.

هذه الوثيقة لا تستبدل الخطة 08. الخطة 08 تحدد المعمارية والاتجاه؛ هذه الوثيقة تحدد **حزمة الإغلاق المتبقية، ترتيبها، بوابات القبول، وخطة الرجوع**.

---

## 2. الحالة التي نبني عليها

تم بالفعل إنجاز الأساس المعماري التالي:

- `BusinessDomainManifest` و`BusinessDomainRuntime`.
- Domain registry وcomposition root موحد.
- Change executor registry.
- Native tool ownership لـ FX V2 وCoverage وIntents.
- Canonical Business Events.
- General `business_event_outbox`.
- Event projector registry.
- FX customer WhatsApp cutover مفعّل في TEST.
- Coverage customer WhatsApp cutover مفعّل في TEST.
- Intents موجود كـDomain ثالث حقيقي ويصدر canonical Business Events في shadow mode.
- migration history في TEST وصل حتى 106.

المتبقي ليس إعادة بناء المنصة، بل إغلاق مسارات الانتقال والـlegacy المتبقية.

---

## 3. المراحل الرسمية المتبقية

### Phase 1 — Intents / Service Requests General Outbox Cutover

**الحالة:** IN PROGRESS

الهدف:

نقل customer-facing Intents outcomes من الاعتماد الفعلي على `customer_intent_notifications` إلى `business_event_outbox` بنفس استراتيجية FX/Coverage:

`shadow → compare → readiness → explicit activation → reversible fallback`

الأحداث الداخلة في cutover الحالي:

- `service_request.approved`
- `service_request.rejected`
- `service_request.matched`
- `service_request.needs_clarification`

ملاحظة مهمة:

`service_request.completed` موجود في Domain contract والقوالب، لكنه لا يملك authoritative producer في lifecycle الحالي لـ `customer_intents`. لذلك **لا يدخل readiness gate لهذه المرحلة**. إدخاله الآن سيجعل البوابة غير قابلة للإغلاق دون اختراع state transition غير موجود.

#### نطاق التنفيذ

1. إضافة route control:
   - `service_request_customer_whatsapp`
2. إبقاء الوضع الافتراضي:
   - `legacy`
3. ترقية **الأحداث المستقبلية فقط** إلى `active` بعد التفعيل.
4. عدم ترقية historical shadow rows.
5. عدم إرسال direct/non-change-request status updates تلقائيًا؛ active routing يقتصر على outcomes المرتبطة بـ `change_request_id` حتى نحافظ على السلوك التاريخي.
6. readiness يعتمد على:
   - matched parity لكل event type المطلوب.
   - عدم وجود blockers.
   - عدم وجود legacy nonterminal rows.
   - عدم وجود active nonterminal rows.
7. rollback:
   - يمنع الرجوع أثناء `sending/requires_reconciliation`.
   - يزامن legacy rows التي أرسلت عبر المسار الجديد.
   - يعيد pending/failed active rows إلى shadow.
8. لا حذف لأي legacy table/column/trigger في هذه المرحلة.

#### بوابة الخروج

- migration الجديدة تطبق على TEST.
- schema verification يثبت RPCs والtrigger والصلاحيات.
- shadow renderer يحقق parity لكل الأنواع الأربعة.
- readiness = true.
- activation يتم فقط باختبار opt-in صريح.
- إرسال أحداث مستقبلية عبر active path ينجح دون duplicate WhatsApp.
- rollback test يثبت إمكانية العودة.
- بعد نجاح rollback يمكن إعادة activation للتجربة المستمرة.

---

### Phase 2 — Services / Pricing Native Platform Ownership

**الحالة:** COMPLETE

الهدف:

إخراج المعرفة المتبقية عن:

- `service/update`
- `pricing_rule/publish`
- `pricing_rule/create_and_attach`

من `src/lib/ai/runtime/change-request-executor.ts` ومن registries الانتقالية.

المطلوب:

- Domain/module ownership واضح للخدمات والتسعير.
- typed native tool manifests.
- native tool executors.
- change action manifests + exact action identity.
- deterministic change executors.
- contract tests.
- الحفاظ على published-agent compatibility أثناء الانتقال.

بوابة الخروج:

لا يعرف generic Change Request kernel معنى service أو pricing mutation.

---

### Phase 3 — Shared Business Primitives Closure

**الحالة:** COMPLETE

الهدف:

تثبيت primitives المشتركة بدل النسخ المحلية.

النطاق:

- Decimal parsing/validation.
- Money JSON contract.
- Currency validation/normalization.
- idempotency helpers.
- optimistic/version conflict helpers.
- standard DomainError mapping.

قاعدة التنفيذ:

لا ننقل ملفًا لمجرد الشكل. كل extraction يجب أن يزيل duplication فعليًا ويثبت بالاختبار.

---

### Phase 4 — Domain-Owned System Templates

**الحالة:** IN PROGRESS

الهدف:

إزالة اعتماد Domains على ملف system defaults مركزي متزايد الحجم.

المسار المستهدف:

`Domain templates → SystemTemplateRegistry → resolver`

تبقى القوالب العامة فقط في Messaging Platform.

يجب الحفاظ على:

- account overrides.
- immutable revisions.
- locale fallback.
- secret policy.
- template safety.
- emergency fallback.

---

### Phase 5 — Legacy Notification / Registry Contraction

**الحالة:** PENDING

لا تبدأ قبل إغلاق Phase 1 وPhase 2.

النطاق المتوقع:

- إزالة legacy tool specs التي لم يعد لها مستهلك.
- تقليص `legacy-bridge`.
- إزالة branches القديمة من customer notification fallback عند ثبوت عدم الحاجة.
- تقليص الاعتماد على `customer_intent_notifications`.
- عدم حذف migration history.
- عدم حذف fallback قبل إثبات rollback/cutover لكل Domain معني.

---

### Phase 6 — Final Architectural Acceptance

**الحالة:** PENDING

المطلوب قبل إعلان Service Platform V2 مكتملة:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `npm run lint`
5. migration replay على clean database.
6. schema verification.
7. TEST/STAGING live E2E لـ FX.
8. TEST/STAGING live E2E لـ Coverage.
9. TEST/STAGING live E2E لـ Intents.
10. التحقق أن إضافة Domain جديد لا تحتاج branch جديد داخل:
   - AI Runtime
   - Change Request kernel
   - Notification worker
   - Template resolver
11. مراجعة `PROJECT_NOTES.md` للمخاطر المؤجلة.
12. مقارنة branch مع نقطة الرجوع قبل أي قرار دمج لاحق.

---

## 4. ترتيب التنفيذ

```text
Phase 1  Intents outbox cutover
   ↓
Phase 2  Services/Pricing native ownership
   ↓
Phase 3  Shared primitives closure
   ↓
Phase 4  Domain-owned templates
   ↓
Phase 5  Legacy contraction
   ↓
Phase 6  Full acceptance
```

السبب:

لا نحذف legacy infrastructure قبل أن تصبح جميع business paths المهمة على contracts الجديدة، ولا ننفذ cleanup شكلي قبل إغلاق مسارات delivery والتنفيذ الحتمي.

---

## 5. قواعد العمل

- لا big-bang rewrite.
- لا حذف لمسار rollback في نفس مرحلة cutover.
- TEST/STAGING أولًا.
- migrations additive.
- لا تعديل migrations تاريخية.
- لا تفعيل route جديد بمجرد تطبيق migration.
- readiness evidence يجب أن تكون من أحداث حقيقية؛ لا نصنع historical facts.
- active delivery يجب أن يحافظ على transport idempotency.
- أي حالة business جديدة يجب أن تبقى domain-owned.
- أي change جديد في kernel يجب تبريره كـplatform concern وليس domain concern.

---

## 6. سجل التنفيذ

### Phase 1

- [x] تعريف النطاق والأحداث الداخلة في cutover.
- [x] تخصيص migration رقم 107 بعد التحقق أن آخر migration هو 106.
- [x] إضافة controlled route/readiness/rollback SQL عبر migration 107.
- [x] إضافة TypeScript cutover API.
- [x] إضافة contract tests.
- [x] إضافة opt-in live verification.
- [x] تحديث schema verification.
- [x] تطبيق migration 107 على `wacrm test`.
- [x] اكتشاف cross-domain events من Coverage ومنع احتسابها أو تفعيلها عبر migration 108.
- [x] تطبيق migration 108 على `wacrm test`.
- [ ] جمع parity evidence للأحداث الأربعة. الحالة الحالية: 0/4 matched، ولا توجد blockers بعد ownership hardening.
- [ ] readiness = true. الحالة الحالية على TEST: `mode=legacy`, `ready=false`, `blockers=0`, `legacy_nonterminal=0`, `active_nonterminal=0`.
- [ ] activation test.
- [ ] active delivery E2E.
- [ ] rollback test.
- [ ] إعادة activation بعد إثبات rollback إذا كان TEST سيستمر على المسار الجديد.

يتم تحديث هذه القائمة مع تقدم التنفيذ، دون تغيير معايير القبول لتلائم النتيجة.


### Phase 1 — ملاحظة تنفيذية: Ownership hardening

أثناء فحص readiness بعد migration 107 ظهر أن بعض `service_request.approved` shadow rows نتجت من Coverage Change Requests التي غيّرت حالة `customer_intents` إلى `fulfilled`. هذه الأحداث ليست Intents-owned ولا يجوز استخدامها كدليل parity أو تفعيلها عبر route الخاص بـIntents.

القرار:

- لا حذف للتاريخ.
- لا تعديل migration 102 أو 107 بعد تطبيقهما.
- migration 108 تعيد تعريف producer النهائي ليقبل فقط:
  - `intents.decision.apply@1`
  - أو legacy `target_type=service_intent` عندما لا يوجد `action_key`.
- الأحداث التاريخية cross-domain تُصنف `native_only` مع سبب `INTENTS_EVENT_OWNERSHIP_MISMATCH`.
- readiness/activation/rollback تصبح action-owned، وليس event-name-owned فقط.

هذا invariant يصبح جزءًا من Definition of Done للمرحلة الأولى.


### Phase 1 — آخر تحقق مسجل

بعد تطبيق migrations 107 و108 على `wacrm test`:

- route mode بقي `legacy` ولم يحدث cutover تلقائي.
- `verify-schema.sql` نجح على قاعدة TEST.
- RPCs الخاصة بالفحص والتفعيل متاحة لـ `service_role` فقط، وليست قابلة للتنفيذ من `anon/authenticated`.
- الأربع أحداث القديمة التي نتجت من Coverage تم الاحتفاظ بها وتصنيفها `native_only`.
- Intents readiness أصبحت:
  - required: 4 event types.
  - matched: 0.
  - blockers: 0.
  - pending owned types: 0.
  - legacy nonterminal: 0.
  - active nonterminal: 0.
  - mode: `legacy`.
  - ready: `false`.
- سبب عدم الجاهزية الوحيد حاليًا هو عدم وجود evidence حقيقية لكل outcomes الأربعة الخاصة بـIntents.
- Supabase Security Advisor لم يشر إلى وظائف migrations 107/108 الجديدة؛ التحذيرات الأقدم للمشروع تبقى ضمن `PROJECT_NOTES.md`.

الخطوة التالية داخل Phase 1 هي إنشاء/تنفيذ سيناريوهات TEST حقيقية لكل outcome، تشغيل shadow projection comparison، ثم إعادة قراءة readiness. لا يجوز تفعيل المسار قبل وصول matched event types إلى 4/4.


### Phase 1 — ملاحظة تنفيذية: Message parity source

تم اكتشاف أن رسائل Intents القديمة كانت تحمل نصوصًا hard-coded مختلفة عن system templates الخاصة بـ `service_request.*`. الاعتماد على مقارنة النصين كما هما كان سيجعل shadow parity تفشل حتى عندما تكون business facts صحيحة.

القرار المعماري:

- لا نضيف normalization لتغطية الاختلاف.
- لا نحتفظ بنسختين من customer-facing prose.
- `INTENTS_CHANGE_EXECUTORS` يعيد `render_from_business_event: true`.
- legacy `customer_intent_notifications` يبقى موجودًا للـrollback وtransport idempotency فقط.
- عند delivery أو shadow comparison، النص يُرندر من الـcanonical linked Business Event عبر Event Projector + Template Resolver.
- هذا يطابق النمط الذي أصبح مستخدمًا في Coverage ويجعل القالب مصدر الحقيقة الوحيد للرسالة.

### Phase 1 — TEST Evidence Harness

تمت إضافة harness اختياري:

`src/lib/services/intents/cutover-evidence.live.test.ts`

ويجب تشغيله فقط على TEST مع:

```text
WACRM_INTENTS_CUTOVER_EVIDENCE_LIVE=1
WACRM_INTENTS_CUTOVER_EVIDENCE_CONFIRM=GENERATE_TEST_EVIDENCE
WACRM_INTENTS_CUTOVER_LIVE_ACCOUNT_ID=<test-account>
```

قواعد الأمان فيه:

- يبدأ فقط عندما route mode = `legacy`.
- يوقف recovery worker مؤقتًا أثناء إنشاء fixtures ثم يعيد القيمة السابقة.
- يستخدم contact sink واضح باسم `[TEST] Intents Cutover Sink — DO NOT MESSAGE`.
- proposal تُنشأ مباشرة عبر authoritative `create_change_request_v3` حتى لا يتم إرسال trusted-admin WhatsApp alert أثناء fixture setup.
- approval يتم عبر عقد approval الحقيقي.
- deterministic execution يتم عبر `executeApprovedChangeRequest` الحقيقي.
- legacy notification الناتجة من التنفيذ تُجعل terminal داخل TEST قبل إعادة worker، لذلك لا تستخدم كاختبار transport.
- shadow comparison نفسه يستخدم canonical projector/template.
- الـharness يجب أن يصل إلى 4/4 matched قبل السماح بالactivation.

**تنبيه للرجوع لاحقًا:** هذا الـharness يثبت producer + approval + executor + legacy bridge + projector/template parity. لا يعتبر اختبار WhatsApp transport الفعلي. active transport E2E يحتاج رقم TEST مخصص قبل إغلاق Phase 1 نهائيًا.

### Temporary branch CI gate

تم توسيع GitHub Actions مؤقتًا ليعمل `CI` و`Migrations` على push إلى `refactor/service-platform-v2` أيضًا، حتى نحصل على دليل فعلي لـ lint/typecheck/tests/build/migration replay أثناء العمل.

**ملاحظة cleanup لاحقة:** عند إغلاق الفرع/دمجه، إما إزالة اسم الفرع من workflow filters أو تحويل سياسة CI إلى قاعدة branch عامة إذا تقرر إبقاؤها.


### Phase 1 — Clean-database safety smoke

تمت إضافة `supabase/ci/intents-cutover-smoke.sql` إلى Migrations CI.

يثبت على قاعدة تُبنى من الصفر:

- default route = `legacy`.
- readiness لا تصبح true دون evidence.
- activation بدون evidence يفشل بـ `INTENTS_BUSINESS_EVENT_CUTOVER_NOT_READY`.
- producer النهائي يحتوي ownership guard لـ `intents.decision.apply`.
- route function تحتوي ownership guard + route key الصحيح.
- readiness/mode RPCs غير متاحة لـ `anon/authenticated`.

هذا الفحص مستقل عن TEST live evidence ويجب أن يبقى جزءًا من migration replay حتى بعد إغلاق Phase 1.


### Verification note — stale FX contract test

عند تشغيل CI على branch الحالي، نجح lint وtypecheck لكن test suite توقف لأن `fx-business-event-delivery-contract.test.ts` كان ما يزال يقرأ الملف المحذوف سابقًا:

`src/lib/services/fx-v2/legacy-notification-adapter.ts`

لم تتم إعادة إنشاء هذا الملف لأن ذلك سيعيد legacy seam أزيل عمدًا. تم تحديث الاختبار ليتحقق من المعمارية الحالية:

`legacy notification link → generic business-event-delivery → CURRENT_EVENT_PROJECTOR_REGISTRY → FX projector`

أي أن contract test أصبح يثبت غياب FX semantics من generic delivery kernel ووجودها داخل `fx-v2/message-projectors.ts`.

هذه ملاحظة مهمة عند Legacy Contraction: لا نصلح اختبارات قديمة بإعادة abstractions انتهى دورها؛ نحدّث contract إلى ownership الحالي.


## 7. Verification checkpoint — 2026-09-24

تم تشغيل GitHub Actions فعليًا على `refactor/service-platform-v2` بعد إضافة branch CI gate.

### General CI

آخر run على HEAD بعد إصلاح stale FX contract:

- `npm ci`: success.
- `npm run lint`: success.
- `npm run typecheck`: success.
- `npm test`: success.
- `npm run build`: success.

وبذلك أصبح لدينا تحقق فعلي على الفرع، وليس مجرد وجود اختبارات في المستودع.

ملاحظات غير حاجبة ظهرت أثناء التشغيل ويجب عدم نسيانها:

- lint يحتوي warnings قديمة في أجزاء متعددة من المشروع لكنه لا يفشل.
- `npm ci` أبلغ عن dependency audit findings: 12 vulnerabilities وقت هذا التشغيل:
  - 1 low
  - 6 moderate
  - 4 high
  - 1 critical
- لا يتم إصلاح dependency audit ضمن Phase 1 تلقائيًا؛ يجب مراجعته ضمن Final Architectural Acceptance/maintenance حتى لا يتوسع نطاق cutover بصمت.

### Migration CI

تم بنجاح:

- تشغيل Supabase local database.
- replay لكل migrations من الصفر حتى 108.
- `supabase/ci/verify-schema.sql`.
- `supabase/ci/intents-cutover-smoke.sql`.
- FX V2 Phase 2 smoke.
- FX V2 Phase 6 messaging smoke.
- FX V2 Phase 7 legacy cleanup smoke.

هذا يثبت أن migrations 107/108 قابلة لإعادة البناء من الصفر ولا تعتمد فقط على حالة قاعدة TEST الحالية.

---

## 8. Phase 1 — ما تبقى قبل الإغلاق

الكود والبنية وDB safety gates جاهزة. **لا نعلن Phase 1 مكتملة بعد** لأن live evidence وactive transport لم يُثبتا بعد.

### Gate A — Generate real TEST parity evidence

شغّل على بيئة التطبيق المربوطة بـ `wacrm test`:

```bash
WACRM_INTENTS_CUTOVER_LIVE_ACCOUNT_ID=<TEST_ACCOUNT_UUID>
WACRM_INTENTS_CUTOVER_EVIDENCE_LIVE=1
WACRM_INTENTS_CUTOVER_EVIDENCE_CONFIRM=GENERATE_TEST_EVIDENCE
npm run test:intents-cutover-evidence-live
```

هذا الاختبار يحتاج `NEXT_PUBLIC_SUPABASE_URL` و`SUPABASE_SERVICE_ROLE_KEY` الخاصة بـTEST.

النتيجة المطلوبة:

- `matched_event_types = 4`
- `missing_event_types = []`
- `blockers = 0`
- `legacy_nonterminal = 0`
- `active_nonterminal = 0`
- `ready = true`
- route يبقى `legacy`

**لا نستبدل هذه الخطوة بإدخال rows يدويًا عبر SQL**؛ الهدف هو إثبات مسار approval + deterministic executor + native event + legacy bridge + projector/template.

### Gate B — Explicit activation

بعد Gate A فقط:

```bash
WACRM_INTENTS_CUTOVER_LIVE_ACCOUNT_ID=<TEST_ACCOUNT_UUID>
WACRM_INTENTS_CUTOVER_ACTIVATE_LIVE=1
WACRM_INTENTS_CUTOVER_CONFIRM=ACTIVATE_TEST
npm run test:intents-cutover-control-live
```

يجب أن يتحول:

`service_request_customer_whatsapp: legacy → active`

دون ترقية historical shadow rows.

### Gate C — Active WhatsApp transport E2E

الـsink fixture المستخدم لبناء parity **ليس** اختبار transport.

قبل هذا الاختبار يجب تجهيز contact/رقم WhatsApp TEST مخصص ومقبول الإرسال إليه.

المطلوب إثباته:

`intents.decision.apply → business_event_outbox(active) → projector/template → engineSendText → sent`

مع:

- عدم إرسال duplicate من `customer_intent_notifications`.
- نفس transport idempotency boundary.
- legacy row تصبح terminal/sent بعد الإرسال الجديد.

**لا تستخدم contact حقيقي عشوائيًا لهذا الاختبار.**

### Gate D — Guarded rollback

بعد active E2E:

```bash
WACRM_INTENTS_CUTOVER_LIVE_ACCOUNT_ID=<TEST_ACCOUNT_UUID>
WACRM_INTENTS_CUTOVER_ROLLBACK_LIVE=1
WACRM_INTENTS_CUTOVER_CONFIRM=ROLLBACK_TEST
npm run test:intents-cutover-control-live
```

ثم يجب إثبات:

- route = `legacy`.
- لا active rows في `sending/requires_reconciliation`.
- sent-state synchronization يمنع duplicate عند الرجوع.
- pending/failed new-path rows تعود shadow بأمان.

بعد إثبات rollback يمكن إعادة activation في TEST إذا كان المطلوب استمرار التجربة على المنصة الجديدة.

---

## 9. Deferred notes — يجب الرجوع إليها لاحقًا

هذه العناصر مقصودة ومؤجلة، وليست منسية:

1. `service_request.completed`:
   - موجود في Domain event/template contract.
   - لا يوجد له authoritative transition في `customer_intents` حاليًا.
   - لا يدخل Phase 1 readiness.
   - يجب تحديد lifecycle حقيقي له قبل إضافة producer، لا اختراع حدث لمجرد إكمال القائمة.

2. TEST evidence fixtures:
   - sink contact والـintent/change-request evidence الناتجة من harness مخصصة لـTEST.
   - لا تحذف أثناء جمع cutover evidence.
   - cleanup النهائي لها يراجع في Legacy Contraction/Final Acceptance بعد تثبيت الأدلة المطلوبة.

3. Temporary branch CI:
   - `CI` و`Migrations` يعملان حاليًا على push إلى `refactor/service-platform-v2`.
   - عند إغلاق/دمج الفرع يجب إزالة branch-specific filter أو تعميم السياسة بشكل مقصود.

4. Supabase Advisors:
   - وظائف Intents الجديدة في 107/108 لم تظهر ضمن التحذيرات الجديدة أثناء الفحص.
   - توجد تحذيرات أقدم في المشروع (RLS/search_path/SECURITY DEFINER/performance وغيرها) خارج نطاق Phase 1.
   - يجب مراجعتها في Final Acceptance/PROJECT_NOTES بدل إصلاحها بصمت داخل cutover.

5. Dependency audit:
   - سجل CI الحالي 12 findings بينها 1 critical.
   - تحتاج triage مستقل مع مراعاة pinned dependencies وNext.js/Supabase compatibility.
   - لا تستخدم `npm audit fix --force` عشوائيًا.

6. Message source of truth:
   - Intents legacy rows يجب أن تبقى `render_from_business_event` ولا تعود إلى hard-coded customer prose.
   - أي regression يعيد `message_text` خاصًا بالـDomain يعتبر إعادة ازدواجية يجب منعها.

7. Cross-domain ownership:
   - اسم event وحده غير كافٍ لإثبات ownership.
   - Intents cutover يعتمد على `intents.decision.apply@1` أو legacy selector المحدد فقط.
   - Coverage-originated `customer_intents` status changes لا تصبح Intents customer delivery events.

8. Stale contract tests:
   - لا تعاد الملفات/abstractions المحذوفة فقط لإرضاء اختبار قديم.
   - يحدث الاختبار ليصف ownership الحالي ما دام السلوك المقصود موثقًا ومثبتًا.

---

## 10. Current Phase 1 status

```text
Schema/migrations       ✅
Ownership isolation     ✅
Canonical rendering     ✅
Rollback controls       ✅
Clean DB replay         ✅
Lint                    ✅
Typecheck               ✅
Unit/contract tests     ✅
Build                   ✅
TEST parity evidence    ⏳ 0/4 until live harness is run
Readiness               ⏳ false by design
Activation              ⏳ blocked until readiness=true
Active transport E2E    ⏳ needs dedicated TEST WhatsApp recipient
Rollback live E2E       ⏳ after active transport proof
```

Phase 1 تبقى **IN PROGRESS** حتى إغلاق Gates A-D.


### Phase 1 — Active transport harness is prepared

تمت إضافة:

`src/lib/services/intents/cutover-transport.live.test.ts`

والأمر:

`npm run test:intents-cutover-transport-live`

الاختبار **skipped افتراضيًا** ولا يمكنه الإرسال إلا إذا اجتمعت الشروط التالية:

- `WACRM_INTENTS_CUTOVER_TRANSPORT_E2E_LIVE=1`
- `WACRM_INTENTS_CUTOVER_TRANSPORT_E2E_CONFIRM=SEND_TEST_WHATSAPP`
- route الحالي `active`
- readiness الحالية `true`
- TEST contact id محدد صراحة.
- TEST conversation id محدد صراحة ومتطابق مع contact/account.

وهو يثبت:

- إنشاء Intent حقيقية.
- Change Request من النوع `intents.decision.apply@1`.
- approval الحقيقي.
- deterministic execution الحقيقي.
- event مستقبلية تصبح `active`.
- subject-scoped active delivery يرسل رسالة واحدة.
- linked legacy notification تصبح `sent` بنفس `local_message_id`.
- replay ثاني لا يجد شيئًا claimable، أي لا يوجد duplicate send من المسارين.

**لا يتم تشغيل هذا الاختبار على sink الخاص بالـparity.** يحتاج رقم WhatsApp TEST فعلي مخصص للتجربة.

بعد إضافته لا يتبقى في Phase 1 أي harness برمجي ناقص؛ المتبقي هو تشغيل Gates A-D على TEST بالترتيب الموثق.


### Phase 1 — ملاحظة مؤجلة أثناء الانتقال إلى Phase 2

Phase 1 تبقى مفتوحة تشغيليًا فقط عند Gates A-D الموثقة سابقًا: parity 4/4، activation، active WhatsApp E2E، rollback. جميع harnesses جاهزة، ولا يجوز اعتبار Phase 1 مكتملة لاحقًا دون تشغيل هذه الـgates على TEST recipient مخصص.

الانتقال إلى Phase 2 لا يلغي هذه المتطلبات ولا يغير readiness الحالية.

### Phase 2A — Native registration and deterministic mutation extraction

بدأت Phase 2 على أساس الحفاظ على backward compatibility:

- Domain `services` يملك contracts لـ `services.*` وaction `services.update@1`.
- Domain `pricing` يملك `pricing.calculate_quote@1`.
- Domain `pricing_rules` يملك `pricing_rules.propose_service_price@1` وactions:
  - `pricing_rules.create_and_attach@1`
  - `pricing_rules.publish@1`
- tool keys/versions الحالية لا تتغير حتى تبقى published-agent grants صالحة.
- المقترحات الجديدة تكتب exact `action_key/action_version`.
- historical Change Requests بدون action identity تستمر عبر legacy selectors.
- deterministic service/pricing mutation branches تُنقل من generic Change Request kernel إلى domain change executors.
- في Phase 2A تبقى بعض implementation functions في مواقعها القديمة وتُستدعى من domain runtime كطبقة compatibility مؤقتة.
- Phase 2B ستنقل implementations نفسها وتزيل النسخ/التعريفات الانتقالية من `tool-registry` و`business-handoff` و`executors`.

سبب استخدام 3 Domains بدل Domain واحد: عقود الأدوات الحالية تشترط تطابق namespace مع domain key. دمجها تحت اسم جديد يتطلب تغيير tool keys ويكسر grants المنشورة، لذلك نحافظ على boundaries الحالية ونجمعها فقط عبر composition root.


### Phase 2B — Tool implementation ownership and legacy contract contraction

تم نقل source-of-truth للأدوات إلى Domains الجديدة:

- `service-catalog/read-tools.ts` يملك service search/get.
- `service-catalog/matcher.ts` يملك service matching.
- `service-catalog/ai-tool-runtime.ts` يملك proposal/update model executor.
- `pricing/ai-tool-runtime.ts` يملك quote executor.
- `pricing-rules/ai-tool-runtime.ts` يملك pricing proposal executor.

Compatibility:

- `src/lib/ai/tools/service-search.ts` أصبح re-export للمسار الجديد.
- `src/lib/ai/tools/service-matcher.ts` أصبح re-export للمسار الجديد.
- `business-handoff.ts` يعيد تصدير service/pricing proposal executors بدل امتلاك implementations مكررة.
- هذا يسمح للمستهلكين الداخليين القدامى بالاستمرار دون جعل الملفات القديمة مصدر الحقيقة.

Legacy ToolDefinition registry:

- تم إخراج جميع `services.*`, `pricing.*`, `pricing_rules.*` منه.
- يبقى فيه فقط `change_requests.list_pending` كأداة generic transitional.
- API/UI compatibility للأدوات native تستمر عبر `runtime-tool-compat.ts`.

ملاحظة مؤجلة لمرحلة Legacy Contraction:

`src/lib/ai/tools/executors.ts` ما زال يحتوي بعض exports القديمة read-only لخدمات/تسعير قد يستخدمها مستهلك داخلي تاريخي. لم تعد هذه الدوال مسجلة في model runtime ولا مصدر العقود. حذفها النهائي يُجرى بعد فحص consumers ضمن Phase 5، ولا يعاد ربطها كمسار تشغيل.


### Phase 2C — Generic Change Request kernel purity

تمت إزالة `assertExpectedVersion()` من `change-request-executor.ts`.

السبب:

- الدالة كانت تعرف أن `service` تعني جدول `services` وأن `ai_agent` تعني `ai_agents`.
- هذا يتعارض مع boundary الخطة: generic kernel يملك claim/completion/failure/audit، بينما الـDomain يملك current-state validation.
- `services.update` يمرر `change.expectedVersion` إلى `apply_service_agent_change` ويحوّل version conflict إلى `SERVICE_VERSION_CONFLICT`.
- `pricing_rules.create_and_attach` يحمل `expected_service_version` داخل payload ويمرره إلى `apply_service_pricing_change`.
- لذلك إزالة precheck المركزي لا تزيل حماية optimistic concurrency؛ تنقلها إلى المالك الصحيح.
- legacy historical rows تستمر في الوصول إلى نفس Domain executors عبر legacy selectors.

تم كذلك تحديث اختبارات action identity القديمة لتقرأ exact action identity من:
- `service-catalog/ai-tool-runtime.ts`
- `pricing-rules/ai-tool-runtime.ts`
بدل افتراض أن `business-handoff.ts` ما زال يملك هذه المقترحات.


### Phase 2 — Builder/publish compatibility hardening

أثناء contraction تم اكتشاف مستهلك متبقٍ للـlegacy registry داخل `builder-service.ts`.

المشكلة:

لو بقي `validateAgentRevisionForPublish` يستخدم `getRegisteredTool()`، فإن الأدوات native ستظهر كـ`UNKNOWN_TOOL` عند محاولة نشر revision، رغم أن runtime يستطيع تنفيذها.

الإصلاح:

- publish validation يعتمد الآن على `getCurrentPlatformTool(tool_key, tool_version)` exact-version.
- إذا لم يوجد المفتاح إطلاقًا → `UNKNOWN_TOOL`.
- إذا كان المفتاح معروفًا لكن النسخة المجمدة لم تعد مسجلة → `STALE_TOOL_VERSION`.
- permission validation تقارن مباشرة مع `PlatformToolManifest.permission`.
- لا يفرض builder أحدث نسخة على revision منشورة؛ النسخة المجمدة تبقى صالحة طالما contract exact-version ما زال مسجلاً.

هذه نقطة compatibility أساسية ويجب الحفاظ عليها عند إضافة Domains جديدة لاحقًا.


### Phase 2 — Agent-template grant seeding compatibility

اكتُشف أثناء فحص consumers بعد نجاح CI أن إنشاء وكيل جديد من template كان ما يزال يستخدم `getRegisteredTool()` عند تحويل `suggested_tool_keys` إلى grants.

بعد contraction، هذا كان سيؤدي إلى إسقاط أي أداة native من الوكيل الجديد بصمت، لأن legacy registry لم يعد يملك Services/Pricing/FX/Coverage/Intents.

تم التصحيح بحيث:

- template seeding يحل المفتاح من `getCurrentPlatformTool(key)`.
- لا تُزرع إلا الأدوات `modelExposed` وغير `serverOnly`.
- `tool_version` يأتي من manifest الحالي.
- permission يأتي من `PlatformToolManifest.permission`.
- unknown template keys تظل تسقط بأمان كما في السلوك السابق.
- أضيف contract test يمنع الرجوع إلى `getRegisteredTool()` في هذا المسار.


### Phase 2 — Executable ownership contraction

تمت إزالة implementations المكررة التالية من `src/lib/ai/tools/executors.ts`:

- `executeServicesSearch`
- `executeServicesGet`
- `executeServicesMatchRequest`
- `executePricingCalculateQuote`

للحفاظ على backward compatibility، يحتفظ الملف بالأسماء التاريخية كـre-exports فقط نحو المالكين الجدد:

- Service search/get → `service-catalog/read-tools.ts`
- Service matching → `service-catalog/ai-tool-runtime.ts`
- Pricing quote → `pricing/ai-tool-runtime.ts`

بهذا لا يوجد مسار تنفيذي ثانٍ يمكن أن ينحرف عن العقود native، مع بقاء imports الداخلية القديمة صالحة خلال فترة الانتقال.


### Phase 2 — Closure evidence

تم إغلاق Phase 2 بعد مطابقة التنفيذ الفعلي مع بوابة الخروج، وليس اعتمادًا على وجود الملفات فقط.

**Code evidence:**

- `service-catalog` يملك native manifests + model executors + `services.update@1` deterministic change executor.
- `pricing` يملك `pricing.calculate_quote@1` native manifest/executor.
- `pricing_rules` يملك native proposal manifest/executor و:
  - `pricing_rules.create_and_attach@1`
  - `pricing_rules.publish@1`
- `domain-catalog.ts` هو composition root الوحيد لتسجيل Domains/Runtimes الثلاثة.
- `change-request-executor.ts` لا يعرف:
  - `service` target semantics
  - `pricing_rule` target semantics
  - `apply_service_agent_change`
  - `apply_service_pricing_change`
  - `publishPricingRuleRaw`
  - service table version mapping
- `tool-registry.ts` لا يملك أي `services.*` أو `pricing.*` أو `pricing_rules.*`; يبقى `change_requests.list_pending` فقط كـgeneric transitional tool.
- `current-domain-registry.ts` و`current-executor-registry.ts` لا يحتويان registrations انتقالية لـServices/Pricing.
- implementations القديمة في `executors.ts` أزيلت واستبدلت بـcompatibility re-exports فقط.
- `service-search.ts` و`service-matcher.ts` أصبحا compatibility re-exports للمسارات المملوكة للـDomain.
- proposal الجديدة تكتب exact `action_key/action_version`، مع بقاء legacy selectors للصفوف التاريخية.
- agent publish validation وtemplate grant seeding يعتمدان Platform registry، لذلك contraction لا يكسر published-agent/new-agent tool compatibility.

**Verification evidence:**

- Code head: `3abce161ca87f14c8929eb8beff66f2049e36871`
- GitHub Actions CI run: `36181274607`
- `npm run lint`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS
- `npm run build`: PASS
- source gate check: لا توجد service/pricing mutation branches أو registrations مركزية متبقية.

**Database/migrations:**

- Phase 2 لم تتطلب migration جديدة.
- exact action identity تعتمد على migration الحالية الخاصة بـChange Request action identity، مع backward compatibility للصفوف التاريخية.

**ما لا يعنيه هذا الإغلاق:**

- Phase 1 live cutover gates المؤجلة ما تزال مؤجلة كما هو موثق ولا تُعتبر مكتملة بسبب إغلاق Phase 2.
- `change_requests.list_pending` والـlegacy registry العام سيبقيان إلى مرحلة Legacy Contraction المخصصة لهما.
- لم يتم بدء Phase 3 ضمن هذا الإغلاق.

**نتيجة بوابة الخروج: PASS**

الـgeneric Change Request kernel لم يعد يعرف معنى service أو pricing mutation.


### Phase 3A — Money/Decimal + Currency shared ownership

تم استخراج أول مجموعة shared primitives بعد إثبات استخدامها عبر أكثر من Domain.

#### Money / Decimal

المصدر المشترك:

- `src/lib/services/shared/money/decimal.ts`
- `src/lib/services/shared/money/money-json.ts`

العقد:

- القيم المالية تعبر JSON كـdecimal strings.
- الحساب الداخلي يستخدم `Decimal`.
- إعداد `decimal.js` موحد: precision=40 وROUND_HALF_UP.
- `MoneyJson` عقد type-level بسيط: amount + currency، بدون فرض معنى fee/principal/commission على الـDomains.

تم نقل الاستخدام الفعلي في Pricing وFX وCoverage إلى المصدر المشترك.
`src/lib/services/pricing/decimal.ts` أصبح compatibility re-export فقط.

في Coverage Suggestions أزيل `Decimal.set` المحلي، لكن SCALE=4 بقي قرارًا خاصًا بالـDomain لأنه output precision للمطابقة وليس إعداد Decimal عالميًا.

#### Currency code

المصدر المشترك:

`src/lib/services/shared/currencies/currency-code.ts`

ويملك:

- `CURRENCY_CODE_PATTERN`
- `normalizeCurrencyCode`
- `isCurrencyCode`

العقد يدعم ISO codes إضافة إلى historical/local codes مثل `YER_OLD`.

تم:

- إزالة regex المكررة من Pricing Rules.
- فصل FX عن الاعتماد على Currency CRUD للحصول على normalization primitive.
- إبقاء `currencies/crud.ts` كـcompatibility re-export لنفس العقد.

#### حدود مقصودة

`src/lib/currency.ts` لم يُدمج مع primitive الجديد، لأنه UI/deal-display helper أقدم وله fallback/list semantics مختلفة عن account-scoped service currency catalog. دمجه الآن سيخلط UI concerns مع business primitive.

لا migration مطلوبة في Phase 3A.


### Phase 3B — Idempotency + version conflict primitives

تم توحيد نمطين متكررين مع الحفاظ على backward compatibility.

#### Idempotency composition

`src/lib/services/platform/idempotency.ts` يملك الآن بالإضافة إلى normalization:

`composeIdempotencyKey(parts, { maxLength })`

وهو يحافظ عمدًا على الصيغة التاريخية colon-separated ويستخدم maxLength=1200 افتراضيًا. لم يتم إدخال hash format جديد في هذه المرحلة حتى لا تتغير replay identity للمقترحات الموجودة بلا داعٍ.

تم نقل:
- `services.propose_update`
- `pricing_rules.propose_service_price`

من بناء النص + `.slice(0, 1200)` محليًا إلى primitive المشترك.

#### Optimistic version conflicts

أضيف:

`src/lib/services/platform/version-conflict.ts`

ويملك:
- استخراج message آمن من error غير معروف.
- matching عام لمجموعة markers.
- markers المشتركة لعقد service revision concurrency:
  - `SERVICE_VERSION_CHANGED`
  - `SERVICE_CURRENT_REVISION_CHANGED`

Services وPricing Rules يستخدمان نفس detector، لكن كل Domain ما زال يملك code/message الخارجي الخاص به:
- `SERVICE_VERSION_CONFLICT`
- `SERVICE_PRICING_VERSION_CONFLICT`

وبذلك لم تنتقل business semantics إلى helper العام؛ انتقل فقط parsing المتكرر لعقد optimistic concurrency.


### Phase 3C — Domain error mapping closure

تم توحيد error boundary مع الإبقاء على business codes داخل كل Domain.

#### DomainError

`DomainError` أصبح المصدر المشترك الموثوق لـ:
- code
- message
- status

أضيف `describeDomainError(error, fallback)`.

القصد الأمني: لا يتم الوثوق تلقائيًا في أي object يحمل `code/message`. فقط `DomainError` يمرر تفاصيله إلى boundary؛ الأخطاء العامة تستخدم fallback آمن حتى لا تتسرب رسائل DB/SDK بالخطأ.

تم جعل `PricingError` يرث `DomainError` مثل:
- `ServiceError`
- `FxServiceError`
- `IntentError`
- `DomainChangeExecutionError`

وبذلك تستخدم Pricing وIntents tool boundaries نفس mapper بدل casts يدوية إلى `{ code?, message? }`.

#### Change execution mapping

أضيف `mapDomainErrorToChangeExecution(error)` داخل change-executor registry.

FX وPricing Rules لم يعودا يعتمدان على subclass محدد داخل executor؛ أي `DomainError` من خدمة الـDomain يُنقل إلى `DomainChangeExecutionError` مع الحفاظ على code/message/status.

business codes نفسها لم تُنقل إلى shared layer.


### Phase 3 — Closure evidence

تم إغلاق Phase 3 بعد إثبات كل primitive بالاستخدام الفعلي والاختبارات، وليس بمجرد نقل الملفات.

#### Shared primitives المغلقة

- Decimal parsing/validation:
  - `src/lib/services/shared/money/decimal.ts`
  - مستخدم فعليًا من Pricing وFX وCoverage.
  - `pricing/decimal.ts` compatibility re-export فقط.
  - لا `Decimal.set(...)` محلي داخل Coverage.

- Money JSON contract:
  - `src/lib/services/shared/money/money-json.ts`
  - مستخدم في Pricing QuoteInput وCoverage suggestion result shapes.
  - business semantics مثل commission/fee/principal بقيت داخل Domains.

- Currency normalization:
  - `src/lib/services/shared/currencies/currency-code.ts`
  - مستخدم في Currency CRUD وFX وPricing Rules.
  - يدعم historical/local codes مثل `YER_OLD`.
  - لم يتم دمجه قسرًا مع UI helper القديم `src/lib/currency.ts`.

- Idempotency:
  - `normalizeIdempotencyKey`
  - `composeIdempotencyKey`
  - service/pricing proposals لم تعد تكرر تركيب المفتاح و`.slice(0,1200)`.
  - الصيغة التاريخية بقيت كما هي عمدًا لحماية replay compatibility.

- Optimistic/version conflicts:
  - `src/lib/services/platform/version-conflict.ts`
  - parsing/matching للـRPC markers مشترك.
  - كل Domain يحتفظ بالـexternal business code/message الخاص به.

- Domain error mapping:
  - `DomainError` هو العقد المشترك لـcode/message/status.
  - `PricingError` أصبح ضمن نفس hierarchy.
  - `describeDomainError` يمنع تسريب رسائل generic DB/SDK ويستخدم fallback آمن.
  - `mapDomainErrorToChangeExecution` يوحد نقل أخطاء الـDomain إلى deterministic change boundary.
  - FX وPricing Rules لم يعودا يعتمدان على subclass-specific mapping داخل executors.

#### Architecture contract

أضيف contract test في:

`src/lib/services/platform/service-platform.test.ts`

ويمنع regressions التالية:

- إعادة Decimal ownership إلى Pricing.
- إعادة `Decimal.set` محليًا.
- إعادة currency regex مكررة في Pricing Rules.
- إعادة proposal `.slice(0,1200)` محليًا.
- إعادة manual service-version marker parsing.
- إعادة `instanceof FxServiceError/ServiceError` داخل change executors.

#### Verification evidence

- Code head: `47c7eee0b6c820f609d76d6833da597755dc96b1`
- GitHub Actions CI run: `36256665379`
- `npm run lint`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS
- `npm run build`: PASS
- Phase 3 لم تتطلب migration أو تغيير schema.

**نتيجة بوابة الخروج: PASS**

الخدمات لم تعد تحمل نسخًا مستقلة من primitives التي ثبت أنها مشتركة. الـDomain-specific rules بقيت داخل Domains ولم تُسحب إلى shared layer بلا مبرر.

Phase 1 live cutover gates المؤجلة تبقى كما هي ولا تتغير نتيجة إغلاق Phase 3.


### Phase 4A — Domain-owned defaults + SystemTemplateRegistry

بدأت Phase 4 بإكمال ownership الموجود أصلًا في BusinessDomainManifest بدل إنشاء مسار رسائل جديد.

تم إنشاء:

- `src/lib/messaging/system-template-registry.ts`
- `src/lib/messaging/current-system-template-registry.ts`

المسار التشغيلي أصبح:

`Domain templates + Messaging generic defaults → SystemTemplateRegistry → resolver`

#### Domain ownership

Coverage يملك الآن نصوصه في:

`src/lib/services/coverage/messages/templates.ts`

FX V2 يملك نصوصه في:

`src/lib/services/fx-v2/messages/templates.ts`

ولم تعد domain manifests تقوم بفلترة ملف `messaging/defaults.ts`.

Intents لا يملك نسخًا من `service_request.*`؛ هذه القوالب lifecycle عامة وتبقى في Messaging Platform وفق المعمارية.

#### ما بقي في Messaging Platform

- `change_request.*`
- `service_request.*`
- `remittance.completed` لم يعد داخل defaults العامة؛ عُزل في `legacy-system-templates.ts` ومسجل كـ`legacy-remittance` لأن Remittance Domain غير موجود حاليًا.

لا يتم إنشاء Domain وهمي فقط لنقل قالب.

#### Safety / compatibility

- account overrides لم تتغير وتبقى أول أولوية في resolver.
- immutable revision store لم يتغير.
- locale fallback لم يتغير.
- system template registration يرفض duplicate identities.
- secret placeholders غير المعلنة تُرفض عند registration قبل render.
- emergency fallback في Coverage/FX/Service Request/Change Request يستخدم الـcomposed registry الجديد.
- أزيل `SYSTEM_MESSAGE_TEMPLATES` القديم بالكامل بدل إبقاء alias قد يخفي مستهلكًا تاريخيًا؛ typecheck هو gate لكشف أي consumer متبقٍ.
- الـcurrent composed registry لا يُصدّر من messaging barrel لتجنب circular loading عبر Domain Catalog.

لا migration مطلوبة في Phase 4A.


### Phase 4B — Legacy template quarantine

أثناء فحص شرط "القوالب العامة فقط في Messaging Platform" بقي `remittance.completed` كقالب business-specific بلا Domain مسجل.

بدل إنشاء Remittance Domain خارج نطاق الخطة أو حذف قالب تاريخي:

- نُقل القالب إلى `src/lib/messaging/legacy-system-templates.ts`.
- يُسجل في `SystemTemplateRegistry` تحت owner واضح: `legacy-remittance`.
- `messaging/defaults.ts` أصبح يحتوي فقط القوالب العامة للـMessaging/approval lifecycle.
- resolver لا يعرف الفرق؛ lookup contract بقي واحدًا.
- يمكن لـRemittance Domain مستقبليًا أن يتبنى المفتاح عبر registry migration دون تغيير transport/resolver.

هذا عزل legacy وليس إعلانًا بأن Remittance أصبح Domain مكتملًا.


### Phase 4 — Composition cycle hardening

أثناء أول تشغيل كامل للـRegistry ظهر circular dependency لأن `current-system-template-registry.ts` كان يستورد `domain-catalog.ts`، بينما بعض Domain runtimes تصل إلى Change Request notifications التي تستورد Messaging.

تم تصحيح composition بحيث:

- current template registry لا يستورد runtime/domain catalog.
- يسجل arrays الخفيفة المملوكة للـDomains مباشرة:
  - `COVERAGE_MESSAGE_TEMPLATES`
  - `FX_V2_MESSAGE_TEMPLATES`
- BusinessDomain manifests تستخدم نفس arrays، فلا توجد نسخة نص ثانية.
- اختبار composition يمر على `CURRENT_BUSINESS_DOMAIN_MODULES` ويتأكد أن كل `domain.messageTemplates` مسجل في registry تحت owner المطابق.

بهذا يبقى template resolution خفيفًا ولا يسحب AI/Change Request runtimes عند import.
