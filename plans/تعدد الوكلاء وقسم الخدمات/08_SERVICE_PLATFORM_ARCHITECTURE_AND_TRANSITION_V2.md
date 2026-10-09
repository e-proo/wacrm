# WACRM — المرجع المعماري للانتقال إلى منصة الخدمات الموحدة V2

## 1. هوية الوثيقة

- **Repository:** `e-proo/wacrm`
- **Development Branch:** `test/ai-runtime-kb-tools-v2`
- **Baseline عند إعداد الوثيقة:** سلسلة migrations الحالية تصل إلى `089_fx_trade_canonical_business_events.sql`.
- **الدور:** المرجع المعماري الحاكم للانتقال التدريجي من بنية الخدمات الحالية إلى منصة خدمات قابلة للتوسع.
- **النطاق:** منصة الخدمات، الأدوات، الاعتمادات، Business Events، Outbox، Messaging، الصلاحيات، التنفيذ الحتمي، والتكامل مع الوكلاء.

هذه الوثيقة لا تلغي الخطط السابقة المتعلقة بمنطق التغطيات أو أسعار الصرف أو أمن الوكلاء. وظيفتها أن تصبح المرجع الحاكم لكيفية بناء وربط الخدمات الحالية والجديدة بالمنصة.

---

## 2. الهدف

الهدف ليس دمج خدمة التغطيات وخدمة أسعار الصرف في Domain واحد.

الهدف هو استخراج وتثبيت **منصة خدمات مشتركة** تقدم لكل Business Domain البنية التشغيلية العامة، بينما يحتفظ كل Domain بمنطق أعماله الخاص.

يجب أن نصل إلى حالة يكون فيها إنشاء خدمة ثالثة مثل:

- الحوالات.
- المدفوعات.
- الحجوزات.
- خدمات مالية أخرى.
- أي خدمة مستقبلية.

لا يتطلب إعادة تعديل قلب:

- AI Runtime.
- Tool Policy.
- Change Request Engine.
- Approval Engine.
- Notification Worker.
- Messaging Renderer.
- WhatsApp Transport.

بل يكون المطلوب أساسًا إضافة Domain Module جديد وتسجيله.

المبدأ الحاكم:

> **نوحد كيفية تشغيل الخدمات، ولا نوحد معنى الخدمات نفسها.**

---

## 3. الوضع الحالي الذي نبني عليه

يوجد بالفعل أساس قوي ولا ينبغي استبداله.

### 3.1 طبقة أدوات عامة

موجودة تحت:

`src/lib/ai/tools/platform/`

وتشمل:

- `contracts.ts`
- `domain-registry.ts`
- `execution-registry.ts`
- `current-domain-registry.ts`
- `current-executor-registry.ts`
- `legacy-bridge.ts`

وهي بداية صحيحة لمنصة أدوات عامة.

لكن `current-domain-registry.ts` و`current-executor-registry.ts` لا يزالان يحتويان معرفة مركزية بكل Domains الحالية.

### 3.2 Change Request / Approval Engine

المسار الحالي:

`proposal → change_request → human approval → deterministic execution`

موجود بالفعل ويستخدمه أكثر من Domain.

الملفات المهمة:

- `src/lib/ai/runtime/change-requests-service.ts`
- `src/lib/ai/runtime/admin-change-commands.ts`
- `src/lib/ai/runtime/change-request-executor.ts`

المشكلة الأساسية أن `change-request-executor.ts` يحتوي dispatch مركزيًا حسب أنواع أعمال متعددة مثل:

- `pricing_rule`
- `service`
- `fx_rate_pair`
- `fx_trade_request`
- `service_intent`
- `coverage_offer`
- `coverage_request`

وهذا يجب تفكيكه تدريجيًا.

### 3.3 Messaging Platform

موجودة تحت:

`src/lib/messaging/`

وتحتوي بالفعل على:

`MessageContext → Template Resolver → Renderer → Transport`

مع:

- system templates.
- account overrides.
- immutable template revisions.
- locale fallback.
- secret handling.
- emergency fallback.

وقاعدة البيانات أصبحت عامة منذ migration:

`077_message_template_platform.sql`

هذه الطبقة يجب تطويرها، لا استبدالها.

### 3.4 Business Events / Outbox

FX V2 أصبح النموذج الأنضج حاليًا.

المسار:

`Domain Mutation → Canonical Business Event → Durable Outbox → Renderer → WhatsApp`

خصوصًا migrations:

- `084_fx_v2_customer_lifecycle_outbox.sql`
- `088_unified_customer_business_event_claim.sql`
- `089_fx_trade_canonical_business_events.sql`

لكن جدول الـ outbox التاريخي ما زال:

`customer_intent_notifications`

ويعرف أنواع المصادر عبر أعمدة متخصصة مثل:

- `intent_id`
- `fx_trade_request_id`

وهو غير مناسب لإضافة عدد كبير من الخدمات.

---

## 4. البنية المستهدفة

يجب أن تتكون بنية الخدمات المستقبلية من ثلاث طبقات رئيسية:

```text
┌─────────────────────────────────────────┐
│             PLATFORM KERNEL             │
│                                         │
│ AI Runtime                              │
│ Tool Platform                           │
│ Change / Approval Engine                │
│ Business Event Infrastructure           │
│ Messaging / Templates                   │
│ Notification Delivery                   │
│ Audit                                   │
│ Authorization / Capabilities            │
│ Idempotency / Versioning                │
└────────────────────┬────────────────────┘
                     │
┌────────────────────▼────────────────────┐
│         SHARED BUSINESS PRIMITIVES      │
│                                         │
│ Money / Decimal                         │
│ Currency                                │
│ Service Catalog                         │
│ Pricing                                 │
│ Contacts / Conversations                │
└────────────────────┬────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
   ┌────▼────┐  ┌────▼────┐  ┌────▼────┐
   │Coverage │  │  FX V2  │  │ Future  │
   │ Domain  │  │ Domain  │  │ Domains │
   └─────────┘  └─────────┘  └─────────┘
```

---

## 5. ما هو Platform Kernel؟

Platform Kernel لا يحتوي قواعد أعمال التغطيات أو أسعار الصرف.

مسؤوليته فقط:

- تسجيل Domains.
- تسجيل أدواتها.
- اختيار الأدوات المتاحة للوكلاء.
- الصلاحيات.
- Grants.
- إدارة proposals.
- الاعتماد.
- dispatch للمنفذات الحتمية.
- تسجيل الأحداث.
- outbox.
- الرسائل.
- retries.
- idempotency.
- audit.
- transports.

يحظر أن يحتوي قلب المنصة مستقبلًا على منطق مثل:

```text
if domain === coverage
if target_type === fx_trade_request
if event startsWith exchange_rate
```

هذه معرفة يجب أن تكون ملكًا للـ Domain نفسه.

---

## 6. Business Domain Module

المفهوم المركزي الجديد سيكون:

`BusinessDomainModule`

لكن يجب فصله إلى جزأين لأسباب أمنية ومعمارية.

### 6.1 Domain Manifest

جزء declarative ولا ينفذ database writes.

يصف:

- domain key.
- version.
- title.
- capabilities.
- tools.
- change actions.
- business events.
- message definitions.

تصور للعقد:

```ts
interface BusinessDomainManifest {
  key: string
  version: number

  capabilities: readonly string[]

  tools: readonly PlatformToolManifest[]

  changeActions: readonly ChangeActionManifest[]

  events: readonly BusinessEventManifest[]

  messageTemplates: readonly MessageTemplateDefinition[]
}
```

### 6.2 Domain Runtime

جزء server-only.

يحتوي:

- tool executors.
- change executors.
- event projectors.
- business services.

مثال مفاهيمي:

```ts
interface BusinessDomainRuntime {
  key: string

  toolExecutors: ToolExecutorRegistration[]

  changeExecutors: ChangeExecutorRegistration[]

  eventProjectors: EventProjectorRegistration[]
}
```

الهدف من الفصل أن كتالوج الأدوات والقوالب والعقود لا يستورد تلقائيًا DB handlers أو service-role code.

---

## 7. Tool Platform

العمل الموجود في:

`src/lib/ai/tools/platform/`

يستمر ويصبح طبقة الأدوات الرسمية.

الخدمات الجديدة لا تضاف إلى قائمة مركزية ضخمة.

بدل:

```text
current-domain-registry.ts
  + coverage
  + fx
  + future service A
  + future service B
```

يصبح:

```text
coverageDomain.tools
fxDomain.tools
remittanceDomain.tools
```

ثم composition root يقوم بالتسجيل:

```text
registry.register(coverageDomain)
registry.register(exchangeRatesDomain)
registry.register(remittanceDomain)
```

---

## 8. إلغاء الازدواجية الحالية في Tool Contracts

حاليًا يوجد:

`src/lib/ai/runtime/tool-registry.ts`

إضافة إلى:

`src/lib/ai/tools/platform/current-domain-registry.ts`

و`legacy-bridge.ts` يربطهما.

هذا مقبول أثناء الانتقال فقط.

### الهدف النهائي

`PlatformToolManifest` يصبح المصدر الوحيد للعقد.

الأدوات الجديدة لا تدخل `legacy-bridge`.

Coverage وFX يتم نقلهما تدريجيًا إلى Native Manifests.

ولا يحذف legacy registry حتى:

1. تنقل جميع الأدوات المستخدمة.
2. تنجح contract tests.
3. لا يوجد published agent revision يحتاج صيغة قديمة غير مدعومة.

---

## 9. Change Action Platform

هذه أعلى أولوية للـ refactor.

`change-request-executor.ts` يجب ألا يبقى المكان الذي يعرف جميع أنواع الأعمال.

ننشئ:

`ChangeExecutorRegistry`

مثال:

```text
coverage.offer.create
           → CoverageOfferCreateExecutor

coverage.request.create
           → CoverageRequestCreateExecutor

exchange_rates.pair.publish
           → FxRatePublishExecutor

exchange_rates.trade.decide
           → FxTradeDecisionExecutor
```

محرك Change Request يعرف فقط:

```text
claim
  ↓
resolve action
  ↓
validate
  ↓
execute registered executor
  ↓
complete / fail
```

ولا يعرف معنى العملية نفسها.

---

## 10. تطوير عقد Change Request

الجداول الحالية تستخدم بصورة أساسية:

- `target_type`
- `target_id`
- `intent`

وهي مناسبة كبنية legacy، لكنها ليست identifier قويًا لمنصة قابلة للتوسع.

الهدف هو إدخال:

```text
action_key
action_version
```

بصورة additive.

مثال:

```text
action_key = coverage.offer.create
action_version = 1
```

أو:

```text
action_key = exchange_rates.trade.decide
action_version = 1
```

مع استمرار:

```text
target_type
target_id
```

كمعلومات عن الهدف وليس كوسيلة dispatch الأساسية.

### خطة الانتقال

**Expand:** إضافة الأعمدة nullable.

**Dual-write:** العمليات الجديدة تكتب `action_key/action_version` بالإضافة إلى الحقول القديمة.

**Dual-read:** المحرك يستخدم `action_key` عند وجوده، وإلا يستخدم legacy mapping.

**Backfill:** تحديث السجلات المناسبة إن احتجنا تاريخها الجديد.

**Cutover:** كل proposals الجديدة تستخدم action contract.

**Contract لاحق:** إزالة اعتماد runtime على `target_type + intent` كdispatch.

---

## 11. Business Event Platform

يجب اعتماد فرق واضح بين:

### Audit Event

الغرض:

> من فعل ماذا؟ ومتى؟ وعلى أي سجل؟

مثال:

`coverage.request.status_changed`

### Business Event

الغرض:

> حدث شيء ذو معنى تجاري وقد تحتاج أجزاء أخرى من النظام للتفاعل معه.

مثال:

```text
coverage.request.approved
exchange_rate.trade.approved
remittance.completed
```

لا يجوز التعامل مع كل Audit Event باعتباره Business Event.

---

## 12. العقد القياسي للـ Business Event

كل event يجب أن يملك envelope مستقرًا.

مثال:

```json
{
  "event_id": "...",
  "type": "exchange_rate.trade.approved",
  "version": 1,
  "occurred_at": "...",
  "account_id": "...",
  "subject": {
    "type": "fx_trade_request",
    "id": "..."
  },
  "actor": {
    "type": "member",
    "id": "..."
  },
  "correlation_id": "...",
  "causation_id": "...",
  "data": {}
}
```

`event type` لا يكون مجرد database status.

مثال صحيح:

```text
pending_admin
       ↓
exchange_rate.trade.requested
```

وهذا النمط الموجود في FX V2 يصبح المعيار الرسمي.

---

## 13. Snapshot Policy للأحداث

لا يجب أن تعتمد جميع الأحداث على قراءة الحالة الحالية وقت الإرسال.

لكل Business Event يجب تحديد أحد نمطين:

### immutable_subject_reference

يستخدم عندما يكون الـ subject نفسه snapshot غير قابل للتغيير.

FX trade snapshot مثال جيد.

### embedded_event_snapshot

يستخدم عندما قد تتغير بيانات الـ subject بعد وقوع الحدث.

يحفظ الحدث facts اللازمة وقت وقوعه.

المهم:

> الرسالة التي ترسل لاحقًا يجب أن تصف الحقيقة التي وقعت وقت الحدث، لا الحالة التي ربما تغيرت بعدها.

---

## 14. Outbox V2

الجدول:

`customer_intent_notifications`

يستمر مؤقتًا للتوافق.

لكن البنية النهائية يجب ألا تحتوي:

```text
intent_id
fx_trade_request_id
coverage_id
remittance_id
...
```

نحتاج outbox عامًا مثل:

`business_event_outbox`

بحد أدنى:

```text
id
account_id

event_type
event_version

subject_type
subject_id

audience
channel

contact_id
conversation_id

correlation_id
causation_id

payload

status
attempts
available_at

claim_token
claimed_at
sent_at
last_error

created_at
```

مع idempotency/unique identity واضحة لكل event delivery.

---

## 15. الانتقال إلى Outbox V2

لا نعيد تسمية الجدول القديم مباشرة.

التسلسل:

```text
new schema
   ↓
dual-write / adapter
   ↓
shadow claim
   ↓
compare
   ↓
primary read
   ↓
legacy fallback
   ↓
eventual cleanup
```

ولا يتم حذف `customer_intent_notifications` في نفس migration التي تضيف النظام الجديد.

---

## 16. Atomic Business Events

هذا invariant إلزامي.

حيثما يكون الحدث تابعًا مباشرة لتغيير Business State:

```text
Business Mutation
+
Business Event insert
```

يجب أن يتمّا داخل transaction واحدة.

أي:

```text
COMMIT BOTH
or
ROLLBACK BOTH
```

FX V2 يقدم حاليًا نموذجًا جيدًا لهذا.

Coverage يجب نقله تدريجيًا إلى نفس المبدأ.

لا نريد:

```text
database updated
↓
Node.js crashed
↓
business event lost
```

---

## 17. Messaging Platform

المسار الرسمي:

```text
Business Event
      ↓
Event Projector
      ↓
MessageContext
      ↓
Template Resolver
      ↓
Template Renderer
      ↓
Transport
```

لا يعرف Template Renderer جداول الأعمال.

ولا يعرف WhatsApp Transport معنى Coverage أو FX.

---

## 18. Event Projector Registry

حاليًا توجد domain-specific branches في customer notification delivery.

نحتاج Registry:

```text
exchange_rate.trade.approved
        ↓
FxTradeMessageProjector

coverage.offer.approved
        ↓
CoverageOfferMessageProjector
```

ثم worker يفعل فقط:

```text
load event
resolve projector
build MessageContext
resolve template
send
```

ولا يحتاج إلى:

```text
if fx_trade_request_id
if service_intent
```

---

## 19. القوالب

نظام:

- `message_template_revisions`
- `message_template_publications`

يبقى كما هو.

لكن system defaults يجب تدريجيًا أن تكون domain-owned.

بدل ملف مركزي يكبر بلا نهاية:

`messaging/defaults.ts`

يمكن لكل Domain تعريف templates الخاصة به:

```text
coverage/messages/templates.ts
fx-v2/messages/templates.ts
```

ثم يتم تسجيلها في:

`SystemTemplateRegistry`.

تبقى القوالب العامة مثل:

```text
service_request.pending
service_request.approved
service_request.rejected
service_request.completed
```

في Messaging Platform.

---

## 20. قاعدة مهمة: Messaging لا تحسب Business Facts

يحظر أن تقوم طبقة messaging بحساب:

- fees.
- commission.
- exchange rate.
- converted amount.
- availability.

طبقة الرسائل تعرض فقط facts حتمية قادمة من Domain.

لذلك يجب لاحقًا إزالة حساب commission الموجود حاليًا في:

`src/lib/messaging/coverage-customer.ts`

بدل:

`amount × commission_per_thousand`

داخل renderer، يرسل Coverage Domain:

```text
commission_amount
commission_currency
```

كقيمة authoritative.

FX V2 يطبق هذا المبدأ بصورة أفضل حاليًا.

---

## 21. Shared Business Primitives

هناك أشياء ليست Platform Infrastructure، لكنها أيضًا ليست ملكًا لـ Coverage أو FX وحدهما.

### Currency

الـ currencies الحالية يجب أن تكون primitive مشتركة لكل الخدمات.

### Money / Decimal

كل مبالغ النظام تمر عبر:

- decimal strings عبر JSON.
- Decimal داخل TypeScript.
- numeric داخل PostgreSQL.

لا يسمح لكل Domain بإنشاء arithmetic خاص.

### Idempotency

نحتاج contract مشترك، لكن business idempotency keys نفسها يحددها Domain.

### Versioning

Optimistic locking pattern عام.

### Account isolation

`account_id` + RLS + server-side scoping إلزامي.

---

## 22. ما يبقى Domain-Specific

يمنع محاولة تعميم الأمور التالية قسرًا.

### Coverage

- offer/request semantics.
- provider/requester.
- pay/receive direction.
- reservations.
- matches.
- availability.
- commission direction.

### FX

- base/quote semantics.
- business buy/sell.
- rate versioning.
- pair lock version.
- customer buy/sell.
- trade calculation.

هذه تبقى داخل Domains.

---

## 23. البنية المقترحة للمجلدات

لا ننقل كل شيء مباشرة.

البنية المستهدفة:

```text
src/lib/services/
  platform/
    domain-contracts.ts
    domain-registry.ts
    change-actions.ts
    change-executor-registry.ts
    business-events.ts
    event-registry.ts
    composition.ts

  shared/
    money/
    currencies/

  coverage/
    domain.ts
    runtime.ts
    tools/
    changes/
    events/
    messages/
    lifecycle.ts
    ...

  fx-v2/
    domain.ts
    runtime.ts
    tools/
    changes/
    events/
    messages/
    service.ts
    engine.ts
```

بينما:

`src/lib/ai/`

يبقى مسؤولًا عن AI Runtime.

و:

`src/lib/messaging/`

يبقى مسؤولًا عن Message Platform.

---

## 24. مراحل التنفيذ

### المرحلة A — Contracts First

**لا تغير Business Behavior.**

إنشاء العقود الأساسية فقط:

- `BusinessDomainManifest`
- `BusinessDomainRuntime`
- `DomainRegistry`
- `ChangeActionManifest`
- `ChangeExecutorRegistry`
- `BusinessEventManifest`
- `EventRegistry`

وكتابة validation صارم لها.

#### معيار الخروج

يمكن تسجيل Domain تجريبي في الاختبار ويحتوي:

- tool.
- change action.
- event.
- template.

دون تعديل kernel logic.

---

## 25. المرحلة B — استخراج Change Executor Registry

هذه أول عملية refactor تشغيلية.

يتم فصل:

`executeApprovedChangeRequest()`

إلى جزأين.

### Kernel

مسؤول عن:

- claim.
- content digest.
- expiry.
- execution ownership.
- complete/fail.
- audit wrapper.

### Domain executor

مسؤول عن:

- payload validation.
- current-state validation.
- authoritative mutation.
- domain result.

ينقل FX أولًا لأنه أنظف وأصغر boundaries.

بعد نجاحه تنقل Coverage.

#### شرط أساسي

الناتج قبل وبعد النقل يجب أن يكون سلوكيًا متطابقًا.

---

## 26. المرحلة C — Native Domain Tools

نبدأ بإلغاء اعتماد FX وCoverage على:

`legacy-bridge`

تدريجيًا.

كل Domain يصبح مالكًا لـ:

- manifest.
- input schema.
- output schema.
- permission.
- risk.
- side effects.
- planes.
- capabilities.
- constraints.
- executors.

#### معيار الخروج

إضافة tool جديدة داخل Coverage أو FX لا تتطلب تعديل:

`current-domain-registry.ts`

أو switch مركزي آخر.

---

## 27. المرحلة D — Canonical Coverage Business Events

FX لديه canonical lifecycle بالفعل.

يتم تصميم Coverage بنفس المبادئ، مثل:

```text
coverage.offer.requested
coverage.offer.approved
coverage.offer.rejected

coverage.request.requested
coverage.request.approved
coverage.request.rejected

coverage.match.reserved
coverage.match.confirmed
coverage.match.released
coverage.match.fulfilled
```

الأسماء النهائية تعتمد بعد مراجعة lifecycle الحالي.

المهم عدم تحويل database status مباشرة إلى public event contract.

---

## 28. المرحلة E — General Business Outbox

بعد تثبيت Event Contract:

- إضافة outbox العام.
- كتابة adapter للـ legacy outbox.
- dual processing في TEST/STAGING.
- التحقق من عدم تكرار WhatsApp.
- cutover.
- إبقاء legacy fallback.

**عند baseline هذه الوثيقة كان آخر migration هو 089. إذا بدأ التنفيذ بعد ذلك فيجب إعادة التحقق من آخر migration قبل اختيار الرقم التالي.**

---

## 29. المرحلة F — Messaging Projectors

إخراج منطق:

- Coverage customer rendering.
- FX rendering.
- Service intent rendering.

إلى Domain Event Projectors.

ويصبح notification worker عامًا بالكامل.

#### معيار الخروج

worker لا يحتوي أي معرفة بـ:

```text
coverage
exchange_rate
fx_trade_request_id
service_intent
```

باستثناء adapters المؤقتة للـ legacy migration.

---

## 30. المرحلة G — Shared Primitives Cleanup

بعد استقرار contracts، وليس قبل ذلك:

- توحيد money/decimal APIs.
- currency API.
- idempotency helpers.
- version conflict helpers.
- standard domain errors.

ولا ننقل ملفات فقط لتحسين الشكل؛ كل نقل يجب أن يحذف duplication حقيقيًا.

---

## 31. المرحلة H — Legacy Contraction

لا تبدأ إلا بعد نجاح Coverage وFX بالكامل على المنصة الجديدة.

يمكن بعدها تدريجيًا إزالة:

- central tool specs.
- `legacy-bridge` للخدمات المنقولة.
- central executor switch.
- legacy outbox-specific branches.
- deprecated event aliases.
- dead notification paths.

لا يتم حذف التاريخ أو migrations القديمة.

---

## 32. استراتيجية التوافق

يجب تطبيق:

`expand → dual path → shadow/compare → cutover → contract`

على كل جزء حساس.

لا نسمح بـ big-bang rewrite.

ولا نغير جميع:

- tools.
- events.
- outbox.
- messaging.
- executors.

في commit واحد.

---

## 33. سياسة migrations

قواعد إلزامية:

1. لا تعديل migration قديمة.
2. إعادة التحقق من آخر migration قبل أي schema change.
3. migrations الجديدة additive أولًا.
4. TEST/STAGING أولًا.
5. لا حذف عمود legacy قبل إثبات عدم استخدامه.
6. لا تغيير event contracts بأسماء جديدة دون compatibility plan.
7. كل migration ذات outbox/idempotency يجب أن تختبر concurrency.

---

## 34. اختبارات منصة الخدمات

إلى جانب اختبارات كل Domain، نحتاج Platform Contract Tests.

### Registry

- duplicate domains rejected.
- duplicate tool key/version rejected.
- duplicate action/version rejected.
- duplicate event/version rejected.
- domain mismatch rejected.

### Security

- model cannot access execute tools.
- customer cannot execute authoritative writes.
- admin tools need verified identity.
- capabilities enforced.
- account isolation enforced.
- tool secrets stripped.
- approval PIN never enters model context.

### Change Engine

- proposal does not mutate target.
- approval executes exactly once.
- concurrent approvals execute once.
- expired proposal rejected.
- changed target produces conflict.
- executor failure leaves deterministic state.

### Events

- business mutation and event are atomic.
- same event is not enqueued twice.
- retry cannot duplicate transport.
- event version supported.
- unknown event fails safely.

### Messaging

- templates cannot change business truth.
- required facts enforced.
- secret variables isolated.
- invalid account override falls back safely.
- message renderer performs no domain arithmetic.

---

## 35. E2E مرجعية إلزامية

يجب إبقاء على الأقل سيناريوهين كـ architectural acceptance suite.

### Coverage

```text
Customer
→ coverage tool
→ proposal
→ admin notification
→ explicit approval
→ deterministic executor
→ coverage business mutation
→ canonical event
→ outbox
→ MessageContext
→ account/system template
→ WhatsApp
```

### FX

```text
Customer
→ exchange_rates.get_current
→ immutable rate version
→ trade proposal
→ admin decision
→ approval
→ deterministic FX executor
→ canonical trade event
→ outbox
→ immutable trade projection
→ template
→ WhatsApp
```

---

## 36. أوامر التحقق

كل مرحلة برمجية لا تعتبر جاهزة قبل تشغيل ما يناسبها، وفي نهاية مرحلة انتقال كاملة:

```bash
npm run typecheck
npm test
npm run build
npm run lint
```

ولا يعتبر النجاح مفترضًا؛ يجب تسجيل نتيجة التشغيل الفعلية.

---

## 37. قواعد ممنوعة أثناء الانتقال

لا نسمح بما يلي:

- إنشاء `generic_crud` tool.
- إنشاء `run_sql` tool.
- إعطاء النموذج write executor.
- وضع domain-specific branches جديدة في kernel.
- حساب الأموال داخل templates.
- استخدام message text كمصدر Business Truth.
- الاعتماد على AI prose لتحديد state transition.
- إنشاء جدول واحد JSON عام لكل الخدمات.
- دمج Coverage وFX في Domain واحد.
- حذف legacy paths قبل وجود fallback.
- تعديل migration تاريخية.
- استخدام `number` للأموال لمجرد سهولة التنفيذ.
- ربط service module مباشرة بـ WhatsApp transport.

---

## 38. Definition of Done لأي Domain جديد

الخدمة الجديدة لا تعتبر جزءًا صحيحًا من منصة WACRM إلا إذا كان لديها:

1. Domain manifest واضح.
2. Domain runtime منفصل.
3. capabilities.
4. typed tool contracts.
5. read/propose/execute boundaries.
6. deterministic change executors.
7. business events versioned.
8. event snapshot policy.
9. message projectors.
10. templates أو generic fallback واضح.
11. audit.
12. idempotency.
13. RLS/account isolation.
14. concurrency strategy عند الحاجة.
15. contract tests.
16. domain tests.
17. E2E أساسي.
18. rollback/disable path.

---

## 39. الاختبار النهائي للمعمارية

قبل اعتبار مشروع الانتقال مكتملًا، يجب بناء Domain ثالث صغير أو حقيقي باستخدام المنصة الجديدة.

والاختبار الحاكم هو:

> هل نستطيع إضافة Domain جديد دون تعديل AI Runtime أو Change Request Engine أو Notification Worker أو Template Resolver؟

إذا كان الجواب لا، فما زال هناك coupling يحتاج معالجة.

يسمح بتعديل composition root لتسجيل Domain.

لكن لا يسمح بإضافة:

```text
if newDomain...
```

إلى قلب المنصة.

---

## 40. أول حزمة تنفيذ نبدأ بها

لا نبدأ بتغيير outbox أو قاعدة البيانات.

الخطوة الأولى تكون **code-only architectural foundation** قدر الإمكان.

إنشاء:

```text
src/lib/services/platform/
  domain-contracts.ts
  domain-registry.ts
  change-action-contracts.ts
  change-executor-registry.ts
  business-event-contracts.ts
```

ثم اختبارات هذه العقود.

بعد ذلك نأخذ **FX V2 كأول Domain تجريبي** ونغلف implementations الحالية بالعقود الجديدة **من دون تغيير سلوكها**.

إذا نجح FX:

ننقل Coverage.

هذا يعطي إثباتًا أن العقد مناسب لـ Domainين مختلفين قبل تغيير قاعدة البيانات أو الـ outbox.

---

## 41. بوابة المرحلة الأولى

المرحلة الأولى من الانتقال لا تعتبر مكتملة إلا إذا تحقق الآتي:

- `BusinessDomainManifest` موجود ومتحقق.
- Domain registry يمنع العقود غير الصحيحة.
- Change executor registry يعمل exact key/version.
- FX V2 مسجل عبر Domain Module.
- لا يتغير سلوك الأدوات الحالي.
- لا يتغير approval flow.
- لا يتغير WhatsApp flow.
- جميع الاختبارات الحالية تبقى ناجحة.
- توجد اختبارات جديدة تثبت إمكانية إضافة Domain وهمي دون تغيير kernel.
- لا migration جديدة إذا لم تكن ضرورية لهذه المرحلة.

---

## 42. ترتيب الأولويات

الترتيب الرسمي:

```text
1. Domain contracts
       ↓
2. Change executor registry
       ↓
3. Native tool ownership
       ↓
4. Canonical coverage events
       ↓
5. Generic business outbox
       ↓
6. Event projector registry
       ↓
7. Messaging purity
       ↓
8. Shared primitives cleanup
       ↓
9. Legacy cleanup
       ↓
10. Third-domain validation
```

السبب هو أننا لا نريد تغيير التخزين والأحداث قبل أن نثبت حدود الـ Domain نفسه.

---

## 43. النتيجة النهائية المطلوبة

عند اكتمال هذه الخطة، إضافة خدمة جديدة يجب أن تبدو تقريبًا هكذا:

```text
New Service Domain
       │
       ├── Business Logic
       ├── Tools
       ├── Change Actions
       ├── Business Events
       ├── Message Projectors
       └── Templates
              │
              ▼
       Service Platform
              │
       ┌──────┼──────┐
       ▼      ▼      ▼
      AI   Approval Events
                    │
                    ▼
                 Outbox
                    │
                    ▼
               Messaging
                    │
                    ▼
                WhatsApp
```

ولا تحتاج الخدمة إلى اختراع دورة:

- أدوات جديدة خاصة بها خارج المنصة.
- approval system جديد.
- notification worker جديد.
- template engine جديد.
- WhatsApp sender جديد.
- agent runtime جديد.

---

## 44. القرار المعماري النهائي

يتم اعتماد القاعدة التالية كقاعدة تطوير WACRM المستقبلية:

> **Business Domains تملك منطق الأعمال والعقود الخاصة بها.**
>
> **Platform Kernel يملك التشغيل والأمان والتوجيه والاعتماد والأحداث والرسائل.**
>
> **أي ميزة جديدة يجب أن تمتد عن طريق التسجيل في العقود، لا عن طريق إضافة حالات خاصة إلى قلب المنصة.**

وهذه هي القاعدة التي يجب مراجعة كل refactor وكل خدمة جديدة مقابلها.
