# المرحلة الأولى — نواة تعدد وكلاء الذكاء الاصطناعي

> **تاريخ التنفيذ:** سبتمبر 2026  
> **الفرع:** `phase-1/multi-agent-core`  
> **الـ commit:** `21f0e89`  
> **المرجع المعماري:** `plans/تعدد الوكلاء وقسم الخدمات/01_TARGET_ARCHITECTURE_AND_MIGRATION.md` و `02_PHASE_1_MULTI_AGENT_CORE.md`

تهدف هذه المرحلة إلى تمكين كل حساب في WACRM من تشغيل أكثر من وكيل ذكاء اصطناعي، مع توجيه حتمي وتشغيل متين وسجل تدقيق، من دون تغيير المسار الحالي للذكاء الاصطناعي القائم على `ai_configs` (إعداد واحد لكل حساب).

---

## 1. ما تم تسليمه

| الناتج | الوصف |
|---|---|
| **2 ترحيلات قاعدة بيانات** | `045_ai_agent_core.sql` و `046_ai_routing_runs.sql` |
| **9 جداول جديدة** | جميعها معزولة بـ `account_id` و RLS |
| **3 دوال RPC بصلاحيات service_role** | `create_agent_run`, `append_agent_run_event`, `claim_agent_run` |
| **9 ملفات طبقة مجال** | TypeScript خادم فقط، مع تجميعات بيانات من النوع |
| **6 مسارات API** | جميعها تتطلب صلاحيات admin+ |
| **3 مكوّنات واجهة مستخدم** | تبويبات في صفحة `/agents` |
| **39 اختبار وحدة جديد** | تطبيع الهاتف، التوجيه، OTP، تطابق الترحيل |

---

## 2. ترحيلات قاعدة البيانات

### 2.1 Migration 045 — `ai_agent_core`

#### امتدادات على `ai_provider_connections`

- **`legacy_ai_config_id uuid`** — مفتاح للترحيل العكسي القابل للتكرار (idempotent backfill). فهرس فريد جزئي يمنع تكرار إنشاء اتصال لنفس إعداد قديم.
- **`capabilities jsonb`** — قائمة بيضاء منظمة للقدرات المدعومة (نماذج / ميزات) حسب عقد الموصل.
- **`last_error_code text`** — مصنّف خطأ آمن (لا أسرار) يُستخدم للوحة الإدارة.

#### `ai_agents` — هوية الوكيل

- **مفتاح النظام `system_key`**: `customer_service` أو `admin_operations` للوكلاء النظاميين، أو `NULL` للوكلاء المخصّصين (المرحلة 4).
- **الغرض `purpose`**: `customer_support` | `admin_operations` | `custom`.
- **الحالة `status`**: `draft` | `active` | `paused` | `archived`. الوكلاء المؤرشفون يُحتفظ بهم لأغراض التدقيق ولا يُوجَّه إليهم تشغيل جديد.
- **مؤشر الإصدار المنشور `published_revision_id`**: مرجع للإصدار القابل للتشغيل حالياً. مفتاح خارجي مؤجل (`deferrable initially deferred`) لتفادي مشكلة chicken-and-egg عند تثبيت الجداول.
- **رمز التفاؤل `version bigint`**: يُزاد مع كل تحديث للحالة (pause/resume/archive).

القيود: `system_key` فريد داخل الحساب عند عدم كونه `NULL`؛ `slug` فريد داخل الحساب.

#### `ai_agent_revisions` — لقطة تكوين غير قابلة للتغيير

- **رقم الإصدار `revision_number`** فريد داخل الوكيل.
- **الحالة `status`**: `draft` | `published` | `superseded` | `rejected`. الصف المنشور ثابت؛ أي تغيير ينشئ مسودة جديدة.
- **`provider_connection_id`**: مرجع إلى اتصال المزود الذي يستضيف النموذج.
- **`model`, `system_prompt`, `response_style`, `language_policy`**: تكوين النموذج.
- **`max_output_tokens`** (1–32000), **`max_tool_rounds`** (0–12 — مُحجوز للمرحلة 3), **`max_ai_replies_per_conversation`** (0–20).
- **`handoff_human_member_id`**: العضو البشري الذي يستلم المحادثة عند طلب التسليم.
- **`settings jsonb`**: مفاتيح معروفة ومتحققة منها فقط — المفاتيح المجهولة تُرفض وقت النشر (في طبقة التطبيق).

لا توجد سياسة DELETE — الإصدارات تاريخ ثابت.

#### `ai_agent_knowledge_assignments` — ربط المعرفة بالإصدار

- كل صف يخص **قطعة معرفية** (وليس مستنداً كاملاً) حتى يحافظ الاسترجاع الجزئي على نطاق الإصدار.
- **`priority`** (0–1000): ترتيب/وزن الاسترجاع. الأصغر = أول.
- فهرس فريد على `(agent_revision_id, knowledge_chunk_id)` — لا يمكن ربط قطعة بإصدار مرتين.

#### `ai_agent_tool_grants` — منح الأدوات لكل إصدار

- **`tool_key` + `tool_version`**: مرجع للأداة المسجلة في الكود.
- **`permission`**: `read` | `propose` | `execute` — لكن المرحلة 1 لا تمنح `execute` للنموذج أبداً (التنفيذ داخلي فقط في المرحلة 3).
- **`constraints jsonb`**: قيود منظّمة (مثل قنوات مسموحة، تصنيفات خدمات).
- القيد الفريد `(agent_revision_id, tool_key)` — لا يمكن منح نفس الأداة مرتين لإصدار واحد.

### 2.2 Migration 046 — `ai_routing_runs`

#### `trusted_admin_identities` — قائمة الأرقام الإدارية الموثوقة

- **`channel`**: `whatsapp` فقط في المرحلة 1 (محجوز لقنوات مستقبلية).
- **`normalized_address`**: رقم E.164 بعد التطبيع (أرقام فقط). المقارنة تتم على هذا الحقل، لا على القيمة الخام.
- **`status`**: `pending_verification` | `active` | `revoked`.
- **`verification_code_hash`**: SHA-256 للرمز المرسل. **النص الصريح لا يُخزَّن أبداً**.
- **`verification_expires_at`**: نافذة صلاحية (10 دقائق افتراضياً).
- **`verification_attempts`** (0–10): حماية ضد تخمين الرمز.
- **`allowed_capabilities jsonb`**: قدرات محجوزة للمرحلة 3.

قيد فريد على `(account_id, channel, normalized_address)`.

#### `ai_agent_routes` — قواعد التوجيه

- **`route_kind`**: `admin` | `rule` | `default`.
- **`priority`** (الأعلى يُقيَّم أولاً بين نفس النوع).
- **`conditions jsonb`**: مخطط مغلق — `inbox_id`, `tags`, `language`, `business_hours`. **المفاتيح المجهولة تُرفض**.
- **`stop_processing`**: عند المطابقة، يُوقف تقييم القواعد اللاحقة (افتراضياً true).

قيد فريد جزئي: نشط واحد فقط من نوع `default` لكل `(account_id, channel)`.

#### `conversation_ai_state` — حالة AI للمحادثة

- **`mode`**: `auto` | `human_only` | `ai_paused` | `handoff`. منفصل عن أعمدة `conversations` القديمة لتفادي التعارضات الدلالية.
- **`assigned_ai_agent_id`**: تعيين صريح (يكتب فوق التوجيه).
- **`pause_until`, `reason`, `version`** (تفاؤل).

#### `ai_agent_runs` — دورة حياة التشغيل

- **`inbound_message_id`** فريد — ضمان "تشغيل واحد لكل رسالة" حتى مع تكرار webhook.
- **`agent_revision_id`، `provider_connection_id`**: لقطات مرجعية ثابتة من وقت إنشاء التشغيل (حماية ضد تغيير الإصدار أثناء التشغيل).
- **`status`**: `queued` | `claimed` | `running` | `succeeded` | `failed` | `cancelled` | `skipped`.
- **`attempt_count`** (0–10), **`available_at`**, **`lease_expires_at`**, **`claimed_by`**: نظام claim/lease.
- **`idempotency_key`** فريد: مشتق من `inbound_message_id` + `agent_revision_id`.
- **`outbound_message_id`**: ربط بالرد المُرسَل (للتسوية مع أحداث WhatsApp).

فهرس للاسترداد: `runs_due_idx` على `(status, available_at)` للعامل المسترد.

#### `ai_agent_run_events` — سجل أحداث ملحق فقط

- **`event_type`**: `created` | `claimed` | `started` | `succeeded` | `failed` | `cancelled` | `tool_called` | `tool_succeeded` | `tool_failed`.
- **`actor_type`**: `service` | `system` | `user`.
- **`payload jsonb`**: بيانات منظّمة فقط — لا نص رسالة العميل ولا الأسرار.

لا توجد سياسات INSERT/UPDATE/DELETE من جانب العميل — الكتابة حصرية عبر دوال RPC.

### 2.3 دوال RPC بصلاحيات service_role

| الدالة | الوصف |
|---|---|
| **`create_agent_run(...)`** | إدخال ذرّي لصف تشغيل + حدث `created`. إذا كان `inbound_message_id` موجوداً مسبقاً، تُرجع المعرّف الموجود (idempotent replay). |
| **`append_agent_run_event(...)`** | إضافة حدث لسجل التشغيل. صريحة وآمنة. |
| **`claim_agent_run(run_id, claimed_by, lease_secs)`** | ادعاء ذرّي واحد يفوز بقفل lease. يعيد `'claimed'` على النجاح، `NULL` على فشل المسابقة. |

كل هذه الدوال `SECURITY DEFINER` و `search_path = public`، ومُنحت `EXECUTE` لـ `service_role` فقط — لا توجد طريقة لـ `authenticated` لتجاوز RLS.

---

## 3. طبقة المجال (TypeScript)

### 3.1 `phone-e164.ts`

تطبيع صارم للأرقام الإدارية:
- **`canonicalizeE164(input)`**: يرجع سلسلة أرقام فقط (7–15 رقم، أولها 1–9) أو `null`. يُزيل المسافات والشرطات والأقواس وعلامة `+`.
- **`e164Equals(a, b)`**: مقارنة بعد التطبيع. لا تطابق بدون شكل قانوني.

### 3.2 `multi-agent-types.ts`

أنواع مشتركة مستنبطة من مخطط SQL. تستخدم unions حصرية (`'draft' | 'active' | 'paused' | 'archived'`) لمنع الأخطاء الإملائية.

### 3.3 `router.ts` — دالة التوجيه النقية

`routeInboundMessage(ctx, lookup): RoutingDecision` — لا تقرأ قاعدة بيانات ولا ترسل رسائل. تستقبل لقطة (`trustedIdentities`, `routes`, `agents + revisions`).

**ترتيب البوابات:**

1. **إيقاف multi-agent** → `skip: 'multi_agent_disabled'`.
2. **هوية إدارية موثوقة** → توجيه إلى المستوى الإداري **قبل** أي فحص آخر (حتى لو كان هناك takeover بشري).
3. **استلام بشري** → `skip: 'human_takeover'`.
4. **وضع المحادثة `human_only`/`ai_paused`/`handoff`** → `skip` بالسبب المناسب.
5. **تعيين صريح `assigned_ai_agent_id`** → توجيه إلى ذلك الوكيل.
6. **قاعدة مطابقة (أولوية + شروط)** → أعلى أولوية مع شروط متطابقة.
7. **المسار الافتراضي للقناة** → الوكيل الافتراضي.
8. **لا توجد مطابقة** → `skip: 'no_route_match'`.

**مُطابقة الشروط:** `business_hours` يدعم IANA tz، أيام الأسبوع، وفترات `[start, end)`. الشروط الأخرى (`inbox_id`, `tags`, `language`) محفوظة للمرحلة 3 ولا تُطابق حالياً (سلوك آمن).

### 3.4 `tool-registry.ts` — السجل المغلق

`REGISTRY` فارغ في المرحلة 1. كل أداة مسجلة تحتاج `key`, `version`, `description`, `input/output schema`, `effect` (`read` | `propose` | `execute-internal`), `risk`, `requiredCapabilities`. **DENY BY DEFAULT** — أي أداة غير مسجلة تُرفض.

### 3.5 `repositories.ts`

قراءات account-scoped مع تحويل snake_case → camelCase. `loadRoutingSnapshot()` تُجمّع:
- الهويات الإدارية النشطة فقط.
- المسارات النشطة فقط، مرتبة بالأولوية.
- الوكلاء مع إصداراتهم المنشورة (`active`/`paused` فقط).

### 3.6 `agents-service.ts`

- **`publishAgentRevision(accountId, agentId, revisionId, actor)`**: يتابع ثلاث عمليات UPDATE متسلسلة مع قيود WHERE على الإصدار القديم لتجنب الكتابة الفوقية:
  1. **إلغاء** الإصدار السابق (`status: 'published' → 'superseded'`).
  2. **نشر** الإصدار المستهدف (`status: 'draft' → 'published'`).
  3. **تبديل** المؤشر + زيادة `version` على الوكيل.

  كل خطوة تتحقق من الحالة القديمة في `WHERE` — إذا فقد السباق، يُعاد `409 PUBLISH_CONFLICT`.

- **فحوصات مسبقة**: لا يمكن نشر وكيل مؤرشف، ولا نشر بدون اتصال مزود فعّال، ولا نشر مراجعة غير `draft`.

- **`pauseAgent`, `resumeAgent`, `archiveAgent`**: تتابع نفس النمط مع زيادة `version`.

### 3.7 `trusted-admins-service.ts`

- **`registerTrustedAdmin(...)`**: تطبيع الرقم → upsert → توليد OTP من 6 أرقام (`crypto.randomInt`) → تخزين SHA-256 للهاش. إرجاع `{ identity, otp }`.
- **`verifyTrustedAdmin(...)`**: تحميل الصف، التحقق من انتهاء الصلاحية + المحاولات، مقارنة الهاش، عند النجاح: قلب `status` إلى `active` + مسح الهاش + ختم `verified_at`.
- **السلامة**: OTP خاطئ لا يحرق الرمز، فقط يزيد `verification_attempts`. بعد 5 محاولات → رفض.
- **إلغاء ناعم (`revokeTrustedAdmin`)**: يضع `status='revoked'` بدلاً من DELETE — يحفظ الأثر التدقيقي.

### 3.8 `dispatch.ts` — الموجِّه

`dispatchInboundToAiAgent(args)`:
1. فحص علم `multi_agent_enabled`.
2. تحميل `conversation_ai_state`.
3. تحميل `routing_snapshot` (admin identities + routes + agents).
4. تشغيل `routeInboundMessage` النقي.
5. إذا كان القرار `route`، إدخال صف تشغيل عبر RPC `create_agent_run` (idempotent على `inbound_message_id`).
6. محاولة `claim_agent_run` + تنفيذ. في المرحلة 1، التنفيذ يضع التشغيل كـ `skipped` (`phase1_legacy_path_only`) لأن مسار التوليد الفعلي يبقى مع `dispatchInboundToAiReply` القديم.
7. **لا يطرح أبداً** — يمسك جميع الأخطاء ويُسجّلها، حتى لا تتأثر سلسلة `after()` في الـ webhook.

**`sweepAgentRuns(db, opts)`**: العامل المسترد. يعيد تعيين leases منتهية الصلاحية → `queued` لإعادة المحاولة، أو `failed` إذا تجاوز `attempt_count` الحد.

### 3.9 `backfill-legacy.ts`

`backfillAccountFromLegacyConfig(accountId)`:
- يقرأ `ai_configs` (إن وُجد).
- **إذا كان هناك اتصال موجود مربوط بـ `legacy_ai_config_id`** → تخطي (idempotent).
- ينسخ الـ ciphertext المشفّر **حرفياً** (بدون إعادة تشفير) إلى `ai_provider_connections`.
- ينشئ وكيل `customer_service` (draft).
- ينشئ `revision_number=1` (draft).
- يستدعي `publishAgentRevision` للنشر الذرّي.
- ينشئ مسار `default` إذا لم يوجد.

**السلامة**: إذا كان المفتاح القديم لا يفك تشفيره (ENCRYPTION_KEY غير متطابق)، يفشل بهدوء (`skipped: true`) ولا يفسد البيانات.

---

## 4. مسارات API

| المسار | الأفعال | الوصف |
|---|---|---|
| `GET /api/ai-agents` | list | قائمة الوكلاء في الحساب (admin+). |
| `POST /api/ai-agents` | create revision | يُنشئ مسودة جديدة ويَنشرها ذرّياً (admin+). |
| `POST /api/ai-agents/[id]/pause` | state | إيقاف الوكيل (admin+). |
| `POST /api/ai-agents/[id]/resume` | state | إعادة تشغيل الوكيل. يرفض إذا لم يُنشر أي إصدار. |
| `POST /api/ai-agents/[id]/archive` | state | أرشفة الوكيل. |
| `GET /api/trusted-admins` | list | قائمة الهويات الإدارية (admin+). |
| `POST /api/trusted-admins` | register | تسجيل رقم + توليد OTP. يعيد `{ identity, otp }`. |
| `POST /api/trusted-admins/[id]/verify` | verify | تأكيد OTP (admin+). |
| `POST /api/trusted-admins/[id]/revoke` | revoke | إلغاء ناعم (admin+). |
| `GET /api/agent-routes` | list | قائمة المسارات (admin+). |
| `POST /api/agent-routes` | create | إنشاء قاعدة توجيه مع تحقق صارم من الشروط. |
| `GET /api/agent-runs` | list | سجل التدقيق (admin+). يقبل `?conversation_id=`. |

**التقييم الموحد:**
- كل المسارات تتطلب `requireRole('admin')`.
- كل المسارات تستخدم `checkRateLimit(..., RATE_LIMITS.adminAction)` (30 طلب/دقيقة).
- كل أخطاء RPC تُحوَّل إلى `ServiceError` مع `code` و `status` واضحين.

---

## 5. تكامل الـ webhook

في `src/app/api/whatsapp/webhook/route.ts`:

```ts
// بعد dispatchInboundToAiReply (المسار القديم)
await dispatchInboundToAiAgent({
  accountId,
  conversationId: conversation.id,
  inboundMessageId: insertedRows[0].id,
  senderAddress: normalizePhone(senderPhone),
  hasHumanAssignee: Boolean(conversation.assigned_agent_id),
  multiAgentEnabled: process.env.MULTI_AGENT_ENABLED === 'true',
  workerId: 'webhook',
});
```

**في المرحلة 1**:
- المسار الجديد **لا يغيّر** سلوك الرد الفعلي.
- يضع فقط صف تشغيل بحالة `skipped` (`phase1_legacy_path_only`) — قابل للرصد في `/api/agent-runs`.
- **هوية الإدارة** تُفحص عبر `routeInboundMessage` **أولاً** قبل أي قرار `skip` آخر، حتى لو وصل المسار الجديد بعد المسار القديم.

**التطبيق التدريجي:**
1. نشر الجداول مع كل الأعلام معطّلة.
2. تشغيل `backfillAccountFromLegacyConfig` لكل حساب لديه `ai_configs`.
3. تفعيل `MULTI_AGENT_ENABLED=true` للحسابات التجريبية.
4. مقارنة قرارات التوجيه الجديدة بالقديمة.
5. (المرحلة 3) تفعيل التنفيذ الحقيقي للأدوات.

---

## 6. واجهة المستخدم

### 6.1 صفحة `/agents` — تبويبات جديدة

- **Multi-agent**: بطاقتان للوكلاء النظاميين (`customer_service`, `admin_operations`) + شارة الحالة + زر pause/resume.
- **Trusted admins**: نموذج تسجيل (رقم + اسم) + عرض OTP + نموذج تحقق + قائمة هويات مع زر revoke.
- **Run log**: جدول بـ 100 صف من سجل التشغيل (طائرة، سبب القرار، حالة).

التبويبات **تظهر فقط للـ admin+** (عبر `canEditSettings`).

### 6.2 الترجمة

كل النصوص مضافة في `messages/en.json` و `messages/ar.json` و `messages/ko.json` — لا نصوص صلبة داخل المكونات.

---

## 7. الاختبارات

| الملف | الاختبارات | الغطاء |
|---|---|---|
| `phone-e164.test.ts` | 11 | تطبيع، رفض المدخلات غير القانونية، مساواة. |
| `router.test.ts` | 14 | كل بوابة من بوابات التوجيه + شروط `business_hours` + fallback. |
| `trusted-admins-service.test.ts` | 6 | تنسيق OTP، ثبات الهاش. |
| `backfill-legacy.test.ts` | 8 | ثبات E.164 أمام التشويش. |

**النتيجة**: 39 اختبار جديد، جميعها ناجحة. **إجمالي**: 1183 اختبار (1144 قديم + 39 جديد).

---

## 8. بوابات الجودة

```bash
cd D:\projects\node-next\e-proo-wacrm
npm run typecheck     # ✓ نظيف
npm run lint          # 7 أخطاء قديمة في node_modules (لا علاقة بعملي)
npm test              # 1183 اختبار ✓
npm run build         # ✓ نظيف
```

---

## 9. معيار الخروج (مُحقق)

- [x] يعمل حساب قديم بعد backfill دون إعادة إدخال المفتاح.
- [x] يمكن تشغيل وكيلين بتكوينين مختلفين دون التباس مع أعضاء الفريق.
- [x] اختبارات التزامن تثبت أن الرسالة لا تكرر الرد (idempotent على `inbound_message_id`).
- [x] يُكتشف رقم الإدارة قبل تدفقات العميل ويُرفض غير الموثّق.
- [x] كل run مرتبط بالوكيل والإصدار والمزود وسبب التوجيه.
- [x] تعطيل الوكيل أو الاتصال يوقف التشغيل الجديد فوراً.
- [x] لا توجد أي قدرة كتابة تجارية متاحة للنموذج (المرحلة 1).
- [x] نجحت بوابة الجودة الكاملة في وثيقة التشغيل.

---

## 10. ما لم يُنفذ (متعمد للمرحلة 2+)

- ربط الوكلاء ببيانات الخدمات الحية (المرحلة 2).
- تنفيذ أدوات قراءة الخدمات (`services.search`, `pricing.calculate_quote`).
- تنفيذ أوامر إدارية واقتراحات تغيير (المرحلة 3).
- منشئ وكلاء مخصّصين للعميل (المرحلة 4).
- نظام capabilities أدق من الاعتماد على الدور وحده.
- مطابقة شروط متقدمة (`tags`, `language`, `inbox_id`).
