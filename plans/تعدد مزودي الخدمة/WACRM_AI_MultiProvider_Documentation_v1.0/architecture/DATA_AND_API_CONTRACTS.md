# عقود البيانات وواجهات API

**الحالة:** Normative مع أسماء توجيهية  
**قاعدة مهمة:** فرع المشروع الفعلي هو مصدر أسماء الجداول والملفات. لا تُنسخ SQL التالية بلا مواءمة ومراجعة migration الحالية.

## 1. مبادئ العقود

- طبقة HTTP تتعامل مع DTOs آمنة، وطبقة runtime تتعامل مع السر.
- الأنواع لا تستخدم provider brand كبديل للبروتوكول.
- كل مدخل نصي له طول وحدود وتطبيع واضح.
- كل enum مهم له تحقق runtime؛ TypeScript وحده لا يحمي request body أو database.
- لا يقبل النظام حقولاً مجهولة ثم يمررها إلى provider.
- التواريخ في DTO بصيغة ISO 8601 UTC.

## 2. أنواع المجال

```ts
export const providerProtocols = [
  'openai_compatible',
  'anthropic_compatible',
  'gemini_native',
] as const

export type ProviderProtocol = (typeof providerProtocols)[number]

export const capabilityStates = [
  'supported',
  'unsupported',
  'unknown',
] as const

export type CapabilityState = (typeof capabilityStates)[number]

export interface ProviderCapabilities {
  chat: CapabilityState
  embeddings: CapabilityState
  modelDiscovery: CapabilityState
}

export interface SafeConnection {
  id: string
  name: string
  presetId: string
  protocol: ProviderProtocol
  apiRoot: string
  hasKey: boolean
  status: 'unverified' | 'verified' | 'error' | 'disabled'
  verifiedAt: string | null
  catalogFetchedAt: string | null
  catalogStale: boolean
  catalogErrorCode: string | null
  createdAt: string
  updatedAt: string
}

/** Server-only. Never serialize or log. */
export interface RuntimeConnection {
  id: string
  accountId: string
  presetId: string
  protocol: ProviderProtocol
  apiRoot: URL
  apiKey: string
  fingerprint: string
}

export interface ModelInfo {
  id: string
  displayName: string
  capabilities: ProviderCapabilities
  ownedBy?: string
  inputTokenLimit?: number
  outputTokenLimit?: number
  rawProviderId?: string
}

export interface ModelCatalog {
  models: ModelInfo[]
  fetchedAt: string
  source: 'provider' | 'cache'
  completeness: 'complete' | 'bounded'
  stale: boolean
}
```

## 3. عقود المهايئات

```ts
export interface AdapterContext {
  requestId: string
  connection: RuntimeConnection
  signal: AbortSignal
}

export interface ProviderGenerateInput {
  model: string
  systemPrompt: string
  messages: ChatMessage[]
}

export interface ProviderEmbeddingInput {
  model: string
  inputs: string[]
  dimensions?: number
}

export interface ProviderAdapter {
  readonly protocol: ProviderProtocol
  generate(
    ctx: AdapterContext,
    input: ProviderGenerateInput,
  ): Promise<ProviderResult>
  listModels?(ctx: AdapterContext): Promise<ModelCatalog>
  embed?(
    ctx: AdapterContext,
    input: ProviderEmbeddingInput,
  ): Promise<number[][]>
}
```

### Invariants

- `messages` مرتبة من الأقدم إلى الأحدث.
- الأدوار المسموحة حالياً `user | assistant`؛ system prompt حقل مستقل.
- adapter مسؤول عن تحويل system prompt إلى الصيغة الأصلية.
- usage المفقود يعاد `null`، لا أرقاماً مصطنعة.
- الاستجابة الخالية أو غير القابلة للاستخراج خطأ malformed.
- `embed` يحافظ على ترتيب inputs ويثبت عدد النتائج وطول كل vector.

## 4. Preset contract

```ts
export interface ProviderPreset {
  id: string
  labelKey: string
  protocol: ProviderProtocol
  defaultApiRoot: string
  apiRootMode: 'fixed' | 'custom'
  authStrategy: 'bearer' | 'anthropic_headers' | 'gemini_key'
  availability: 'public' | 'deployment_opt_in'
  supportsCatalog: boolean
}
```

### قواعد validation

- `id`: قائمة server-defined فقط.
- `labelKey`: مفتاح ترجمة، لا اسم من request.
- `defaultApiRoot`: يراجع دورياً مع الوثائق الرسمية.
- `apiRootMode=fixed`: تجاهل/ارفض أي `api_root` يرسله العميل.
- `availability=deployment_opt_in`: لا يظهر ولا يقبل إلا إذا فعله المشغل.
- auth strategy لا يمكن override من العميل.

## 5. مخطط قاعدة البيانات التوجيهي

```sql
-- Illustrative only: adapt types, helper functions, roles, and migration number
-- to the actual repository after Phase 00.
create table public.ai_provider_connections (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  name text not null,
  preset_id text not null,
  protocol text not null check (
    protocol in ('openai_compatible', 'anthropic_compatible', 'gemini_native')
  ),
  api_root text not null,
  encrypted_api_key text not null,
  connection_fingerprint text not null,
  status text not null default 'unverified' check (
    status in ('unverified', 'verified', 'error', 'disabled')
  ),
  catalog jsonb,
  catalog_fetched_at timestamptz,
  catalog_error_code text,
  verified_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, name)
);
```

### تنبيهات SQL

- اسم جدول الحساب والـ FK يجب مطابقتهما للفرع الفعلي.
- تحقق من نمط triggers لـ `updated_at` في المشروع وأعد استخدامه.
- لا تضع ciphertext في view قابلة للعميل.
- لا تستخدم `select *` في route آمن.
- `catalog` يخضع لفحص shape/size في التطبيق، ويمكن إضافة constraint تقريبي إن كان مناسباً.
- إذا كان `created_by` يرتبط بـ `auth.users` أو profiles، اتبع نمط المشروع.

## 6. تعديل config

```sql
alter table public.ai_configs
  add column chat_connection_id uuid,
  add column embedding_connection_id uuid,
  add column embedding_model text,
  add column embedding_dimensions integer,
  add column embedding_revision text;
```

ثم تضيف FKs بعد التحقق من ترتيب backfill والحذف. يُفضل `on delete restrict` لاتصال مستخدم فعلياً، أو service-level unlink transaction؛ لا تستخدم cascade بما قد يمسح إعدادات سلوكية بلا قصد.

### Invariants config

- إذا `is_active=true`، يوجد chat connection صالح وchat model غير فارغ.
- إذا semantic enabled، يوجد embedding connection/model/dimensions/revision متوافقة.
- `embedding_dimensions = 1536` لمسار الفهرس الحالي.
- connection وconfig ينتميان إلى الحساب نفسه. يجب إثبات ذلك server-side، لا الاعتماد على FK منفصل فقط.

## 7. API: قائمة الاتصالات

### `GET /api/ai/connections`

الاستجابة:

```json
{
  "connections": [
    {
      "id": "b587...",
      "name": "OpenAI primary",
      "preset_id": "openai",
      "protocol": "openai_compatible",
      "api_root": "https://api.openai.com/v1/",
      "has_key": true,
      "status": "verified",
      "verified_at": "2026-09-03T10:00:00Z",
      "catalog_fetched_at": "2026-09-03T10:00:00Z",
      "catalog_stale": false,
      "catalog_error_code": null
    }
  ]
}
```

قد تقرر عدم عرض full API root لاتصال خاص لأعضاء غير admin؛ سجل القرار.

## 8. API: إنشاء اتصال

### `POST /api/ai/connections`

طلب:

```json
{
  "name": "DeepSeek production",
  "preset_id": "deepseek",
  "api_key": "secret-from-form",
  "api_root": null,
  "verify": true
}
```

قواعد:

- Admin required.
- `api_key` مطلوب للإنشاء وغير قابل للقراءة لاحقاً.
- `api_root` يُرفض إن كان preset ثابتاً، بدلاً من تجاهله بصمت.
- `verify` لا يسمح بتجاوز policy؛ يقرر فقط هل ينفذ probe الآن.
- لا تعاد نسخة request في الخطأ.

الاستجابة 201 هي `SafeConnection` وربما catalog منفصل. يفضل عدم تكرار catalog كبير في كل list response.

## 9. API: تعديل اتصال

### `PATCH /api/ai/connections/:id`

```json
{
  "name": "Updated name",
  "api_key": "optional-new-secret",
  "api_root": "https://allowed.example/v1/"
}
```

- غياب `api_key` يبقي السر.
- `api_key: null` لا يمسحه ضمن PATCH العام؛ مسح السر فعل مستقل واضح أو endpoint/flag محدد لتجنب الحذف العرضي.
- لا تقبل placeholder.
- تغيير root/key يحسب fingerprint جديداً، يجعل status unverified، ويبقي catalog السابق فقط كـ stale أو يمسحه من العرض وفق القرار؛ لا يعتبره fresh.
- فشل اختبار السر الجديد لا يستبدل القديم.

## 10. API: اكتشاف النماذج

### `POST /api/ai/connections/:id/discover-models`

طلب اختياري:

```json
{ "force_refresh": true }
```

استجابة نجاح:

```json
{
  "catalog": {
    "models": [],
    "fetched_at": "2026-09-03T10:00:00Z",
    "source": "provider",
    "completeness": "complete",
    "stale": false
  },
  "verification": {
    "connection_ok": true,
    "generation_ok": null
  }
}
```

استجابة فشل مع cache:

```json
{
  "catalog": {
    "models": [],
    "fetched_at": "2026-09-02T10:00:00Z",
    "source": "cache",
    "completeness": "complete",
    "stale": true
  },
  "error": {
    "code": "AI_PROVIDER_UNAVAILABLE",
    "message": "Could not refresh models; showing the last successful list.",
    "retryable": true,
    "request_id": "req_..."
  }
}
```

يمكن أن تكون HTTP status غير 2xx مع payload cache أو 200 partial حسب convention المشروع؛ يجب اختيار عقد واحد واختباره. التوصية: status يعكس العملية المطلوبة، والـ UI يحتفظ بالـ cache المحلي/المعاد في body المنظم.

## 11. API: اختبار النموذج

### `POST /api/ai/connections/:id/test-model`

```json
{
  "capability": "chat",
  "model": "provider-model-id",
  "dimensions": null
}
```

أو للـ Embeddings:

```json
{
  "capability": "embeddings",
  "model": "provider-embedding-model",
  "dimensions": 1536
}
```

استجابة:

```json
{
  "ok": true,
  "capability": "embeddings",
  "model": "provider-embedding-model",
  "observed_dimensions": 1536,
  "verified_at": "2026-09-03T10:00:00Z"
}
```

لا تعيد output التوليد التجريبي إلى UI إلا إذا كانت له حاجة واضحة؛ يكفي النجاح والmetadata الآمنة. يجب ألا يحتوي probe على بيانات عميل.

## 12. API: إعداد المساعد

طلب جزئي نموذجي:

```json
{
  "chat_connection_id": "uuid",
  "chat_model": "model-id",
  "embedding_connection_id": "uuid-or-null",
  "embedding_model": "model-id-or-null",
  "embedding_dimensions": 1536,
  "system_prompt": "...",
  "is_active": true,
  "auto_reply_enabled": false
}
```

قواعد:

- validate ملكية connection للحساب.
- لا يختبر provider مجدداً إذا تغير system prompt/toggle فقط.
- إن تغير chat selection، يتطلب generation verification وفق سياسة المنتج أو يسمح بحفظ unverified مع عدم التفعيل؛ القرار يجب أن يكون موحداً.
- embedding selection لا يُفعّل semantic حتى اكتمال compatibility test وre-index.
- partial updates لا تصفر حقولاً غائبة.

## 13. Error envelope

```ts
interface ApiErrorEnvelope {
  error: {
    code: AiPublicErrorCode
    message: string
    retryable: boolean
    request_id: string
    field?: string
  }
}
```

### خريطة statuses إرشادية

| code | HTTP |
|---|---:|
| invalid request/field | 400 |
| invalid credentials | 400 أو 401 داخلياً، مع مراعاة convention الحالي |
| caller unauthorized | 401 |
| caller lacks role | 403 |
| connection not found in account | 404 |
| config conflict/stale write | 409 |
| provider rate limit | 429 أو 502 مع code؛ اختر عقداً ثابتاً |
| outbound blocked | 400 |
| provider unavailable/malformed | 502 |
| provider timeout | 504 |

تمييز caller auth عن provider auth مهم؛ لا تجعل 401 من المزوّد يوحي بأن session المستخدم انتهت.

## 14. Optimistic concurrency

ينصح باستخدام `updated_at` أو version في PATCH لمنع حفظ tab قديم فوق تعديل جديد:

```json
{
  "expected_version": 4,
  "name": "new name"
}
```

عند التعارض يعاد `AI_CONFIG_CONFLICT` ويطلب refresh. إن لم يطبق في الإصدار الأول، يسجل كدين تقني واعٍ لا سلوك صامت.

## 15. Backfill contract

يجب أن يثبت backfill:

- كل config قديم له connection جديد واحد لـ Chat.
- اتصال Embeddings مستقل عند وجود مفتاح منفصل، ويمكن إعادة استخدام Chat connection فقط إذا كانت الهوية/المفتاح والبروتوكول متطابقة فعلاً.
- نفس account ownership.
- نفس model وflags/system prompt/handoff.
- لا secret في output.
- إعادة التشغيل لا تنشئ duplicates؛ استخدم marker أو unique deterministic key.
- الصف الفاشل يبقى قابلاً للقراءة من القديم ويظهر في count خطأ منقح.

## 16. Retention وحذف الاتصال

- الحذف يرفض بـ 409 إذا كان الاتصال مربوطاً بـ Chat أو Embeddings، أو ينفذ transaction تفك الربط فقط بعد تأكيد صريح.
- حذف الاتصال يمسح ciphertext والكتالوج وفق سياسة retention.
- audit event لا يحفظ السر.
- soft delete مفيد إن كانت متطلبات التدقيق تستلزمه، لكنه يبقي السر؛ لذلك يلزم قرار retention صريح.
