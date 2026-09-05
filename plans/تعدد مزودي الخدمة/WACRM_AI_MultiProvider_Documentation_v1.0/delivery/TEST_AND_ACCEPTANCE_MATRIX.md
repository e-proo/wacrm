# استراتيجية الاختبار ومصفوفة القبول

**الحالة:** Normative  
**الهدف:** تحويل المواصفات إلى أدلة آلية قابلة للتكرار، لا اختبارات يدوية مبهمة.

## 1. فلسفة الاختبار

- لا تستخدم مفاتيح حقيقية في unit/CI tests.
- الاختبارات الافتراضية deterministic وتعتمد transports/resolvers/clocks قابلة للحقن.
- اختبارات live-provider، إن أضيفت، منفصلة opt-in ومقيدة ولا تكون شرطاً لـ PR العادي.
- كل إصلاح لخلل أمني أو اختلاف مزوّد يبدأ بـ regression test.
- اختبارات الترحيل تستخدم بيانات fixtures تمثل schema القديم، بما فيها حالات ناقصة/تالفة.

## 2. هرم الاختبار

| الطبقة | الغرض | أمثلة |
|---|---|---|
| Unit | منطق نقي سريع | URL joins، normalizers، error maps، dimensions |
| Adapter contract | توافق wire protocol | headers، paths، payloads، pagination، usage |
| Service integration | business rules | invalidation، cache، ownership، transactions |
| Database/RLS | العزل والترحيل | policies، cross-account، backfill، constraints |
| API route | auth وDTOs | status، error envelope، no-secret response |
| Component/UI | سلوك النموذج | manual entry، stale state، masking، accessibility |
| End-to-end محدود | رحلة إعداد كاملة | create → discover → select → test → save |

## 3. Fixtures المزوّدات

### OpenAI-compatible

- استجابة models قياسية.
- models بلا `owned_by`.
- endpoint 404 بينما chat ينجح.
- chat usage كامل/غائب.
- خطأ JSON معروف، وخطأ HTML غير متوقع.
- root مع `/v1/` وpath مخصص؛ إثبات عدم تكرار النسخة.

### Anthropic

- page واحدة.
- `has_more`/cursor أو العقد الرسمي الفعلي وقت التنفيذ.
- capabilities موجودة وغائبة.
- رسائل متتابعة من الدور نفسه واختبار دمجها.
- usage input/output.

### Gemini Native

- `models/...` IDs.
- `supportedGenerationMethods` لـ generate/embed/كليهما.
- `nextPageToken` متعدد الصفحات.
- token limits.
- embeddings 1536 عند خيار رسمي، وdimension مختلفة للرفض.

### خصم/شبكة

- timeout قبل headers وأثناء body.
- response يتجاوز الحجم.
- redirect إلى loopback/private/metadata.
- hostname يحل إلى public + private معاً.
- IPv4-mapped IPv6.
- rate limit مع `Retry-After` رقم/تاريخ.
- JSON depth/shape غير متوقع ضمن limits.

## 4. Unit test catalog

### Registry/presets

- كل protocol له adapter واحد.
- duplicate registration يفشل عند startup/test.
- preset مجهول يرفض.
- preset ثابت يرفض root override.
- deployment opt-in لا يعمل إذا flag off.

### URLs

- trailing slash normalization.
- preservation لمسار API root.
- لا `/v1/v1`.
- relative path لا يستطيع الصعود خارج root إن كانت السياسة تمنعه.
- رفض credentials/fragment/scheme/port غير المسموح.

### Catalog

- dedupe case policy موثقة؛ لا توحّد IDs case-sensitive خطأ.
- stable sort.
- current saved model pinned حتى لو غائب.
- unknown لا يتحول unsupported.
- bounded pages/models.
- stale-on-error.
- fingerprint invalidation.

### Errors

- 401/403 provider → invalid credentials/permission وليس session logout.
- 429 → rate-limited + retryable وفق السياق.
- timeout → timeout.
- malformed → malformed response.
- response body الحساس لا يظهر في public error/log snapshot.

### Embeddings

- عدد vectors يساوي inputs.
- إعادة ترتيب response بحسب index عند البروتوكول المناسب.
- missing/duplicate/out-of-range index يرفض.
- NaN/Infinity/non-number يرفض قبل vector literal.
- dimension 1536 يقبل؛ 1535/1537 يرفضان.
- لا truncation/padding.

## 5. اختبارات API والصلاحيات

لكل endpoint، غطِّ:

- unauthenticated.
- member.
- admin.
- اتصال الحساب نفسه.
- UUID موجود في حساب آخر.
- body invalid/oversized.
- rate-limited.
- safe success response.
- safe error response.

أضف assertion سلبياً recursively يمنع أسماء الحقول السرية وقيم fixture السرية من كامل JSON.

## 6. اختبارات migration

### بيانات fixture

- حساب OpenAI بمفتاح Chat فقط.
- حساب Anthropic مع مفتاح Embeddings منفصل.
- حساب بلا config.
- config inactive.
- ciphertext legacy إن كان decrypt الحالي يدعمه.
- ciphertext تالف لمعرفة سلوك العزل لا محاولة تجاوز.
- إعادة تشغيل backfill مرتين.

### Assertions

- counts صحيحة ولا duplicates.
- config fields محفوظة.
- العلاقات للحساب الصحيح.
- الفشل في صف لا يحذف القديم.
- fallback loader يعمل للصف غير المرحّل.
- rollback feature flag يعيد القراءة القديمة.
- migration down غير مطلوب إن كان خطره أكبر؛ rollback يكون كود/flag ومخطط additive، ويوثق ذلك.

## 7. اختبارات UI

### Connections

- تغيير preset يحدث الحقول المتوقعة فقط.
- fixed root read-only وpayload لا يستطيع تجاوزه server-side.
- key field فارغ عند edit و`has_key` ظاهر.
- failure يحافظ على المدخلات غير السرية، ويقرر بوضوح كيفية مسح secret من state.
- حذف اتصال مستخدم يعطي conflict ويفسر الخطوة التالية.

### Models

- loading skeleton/status.
- empty successful catalog + manual entry.
- unsupported discovery + manual entry.
- stale catalog مع timestamp.
- saved model غائب يبقى مع شارة.
- refresh لا يغير الاختيار تلقائياً.
- البحث والاختيار باللوحة.

### Embeddings

- عرض required dimensions.
- mismatch يمنع التفعيل.
- change يعرض re-index warning/state.
- Chat connection وEmbedding connection مختلفان.

### i18n/accessibility

- لا missing message keys لكل locales الحالية.
- labels وdescriptions مرتبطة بالحقول.
- live region لحالة التحقق.
- focus يعود للمكان الصحيح بعد dialog.
- اللون ليس الإشارة الوحيدة.

## 8. مصفوفة تتبع المتطلبات

| المتطلب | الدليل الأدنى |
|---|---|
| OBJ-01 التوافق الخلفي | migration fixtures + OpenAI/Anthropic regression |
| OBJ-02 OpenAI-compatible | adapter contract مع مزوّدين مختلفين + custom root |
| OBJ-03 Gemini Native | native adapter/model pagination/generate fixtures |
| OBJ-04 dynamic models/manual | catalog service + UI tests للفشل والغياب |
| OBJ-05 فصل Chat/Embeddings | DB/API/E2E باتصالين مختلفين |
| OBJ-06 حماية الأسرار | response/log/DOM negative assertions |
| OBJ-07 SSRF | IPv4/IPv6/DNS/redirect/port/scheme tests + deployment docs |
| OBJ-08 ترحيل قابل للرجوع | idempotent backfill + flag rollback rehearsal |
| OBJ-09 قابلية التوسع | registry/preset tests ووثيقة إضافة مزوّد |
| OBJ-10 UX الحالة | component tests لـ verified/stale/error/manual |
| FR-CON-07 حذف آمن | reference conflict/transaction tests |
| FR-MOD-06 cache stale | stale-on-error service/API/UI tests |
| Embedding 1536 | dimension tests قبل أي insert/RPC |
| عدم retry للتوليد | transport call count = 1 على timeout |

## 9. سيناريوهات قبول Gherkin مختصرة

### مزوّد لا يدعم `/models`

```gherkin
Given an admin has a valid custom OpenAI-compatible connection
And its models endpoint returns 404
When the admin enters a model ID manually and tests it
And chat completion succeeds
Then the connection can be selected for chat
And the UI does not claim model discovery succeeded
And no cached catalog is erased
```

### كتالوج قديم

```gherkin
Given a connection has a successful cached model catalog
When a forced refresh times out
Then the last catalog remains available and marked stale
And the saved model remains selected
And the response includes a safe retryable error code
```

### منع SSRF

```gherkin
Given private endpoints are disabled for the deployment
When an admin submits a custom root that resolves to a private address
Then WACRM rejects it before sending provider credentials
And no redirect or fallback request is made
And the audit event contains no credential or raw URL secret
```

### Embedding غير متوافق

```gherkin
Given the current knowledge index requires 1536 dimensions
When the selected embedding model returns a 3072-element vector
Then WACRM rejects activation with AI_EMBEDDING_DIMENSION_MISMATCH
And no incompatible vector is persisted
And the previous semantic revision or lexical fallback remains active
```

### ترحيل حساب قديم

```gherkin
Given an existing Anthropic chat config and a separate OpenAI embeddings key
When the backfill runs twice
Then exactly two appropriate connections exist
And chat and embeddings selections preserve their behavior
And the old config remains readable during rollback
And no plaintext key appears in output or logs
```

## 10. أوامر التحقق

استخدم الأوامر الموجودة فعلياً في `package.json`. في اللقطة المرجعية كانت:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

يفضل تشغيل الاختبارات المحددة أثناء التطوير، ثم المجموعة الكاملة وبناء production في بوابة المرحلة. إن تطلب build خدمات خارجية أو env غير متاحة، وثق الأمر والخطأ والمتطلب بدقة، ولا تحوّل عدم التشغيل إلى نجاح.

## 11. Exit criteria للاختبار

- لا failing tests جديدة.
- اختبارات الانحدار الحالية تمر.
- لا skipped test لمعيار أمني إلزامي بلا blocker مسجل وموافقة.
- لا live keys في fixtures أو CI.
- migration fixture وrollback rehearsal ناجحان قبل التفعيل.
- coverage الرقمي ليس بديلاً عن تغطية المسارات الحرجة؛ إن كان المشروع يفرض threshold فيُحترم.

