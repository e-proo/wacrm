# مصفوفة توافق المزوّدات والبروتوكولات

**تاريخ التحقق المرجعي:** 2026-09-03  
**الحالة:** مرجع تصميم؛ يجب إعادة التحقق من الوثائق الرسمية وقت التنفيذ  
**قاعدة:** URLs وأسماء النماذج تتغير. تحفظ presets الجذور الرسمية في الخادم، ولا تحول هذه الصفحة إلى allowlist لأسماء النماذج.

## 1. المصفوفة المختصرة

| المزوّد/النمط | Protocol داخل WACRM | API root المرجعي | Chat | Models | Embeddings | ملاحظة القدرة |
|---|---|---|---|---|---|---|
| OpenAI | `openai_compatible` | `https://api.openai.com/v1/` | `chat/completions` | `models` | `embeddings` | قائمة models أساسية ولا تكفي وحدها لتصنيف القدرة |
| DeepSeek | `openai_compatible` | قيمة preset تتحقق من الوثائق | OpenAI-compatible | OpenAI-compatible | لا يُفترض قبل التحقق | لا hard-code أسماء النماذج |
| OpenRouter أو بوابة عامة مماثلة | `openai_compatible` | preset موثق إن دخل النطاق | غالباً OpenAI-compatible | حسب الخدمة | حسب الخدمة | الاختلافات تختبر بعقد خاص ولا تغير المستهلك |
| 9Router/self-hosted gateway | `openai_compatible` | غالباً deployment-local `/v1/` | OpenAI-compatible | `/v1/models` وفق المشروع المرجعي | حسب backend | يحتاج deployment opt-in/allowlist؛ محجوب افتراضياً |
| Custom OpenAI-compatible | `openai_compatible` | User intent بعد server policy | subset الموثق | اختياري | اختياري | manual model إلزامي كمسار بديل |
| Anthropic | `anthropic_compatible` | `https://api.anthropic.com/v1/` | `messages` | `models` | لا endpoint أصلي مفترض | model pagination وheaders خاصة |
| Custom Anthropic-compatible | `anthropic_compatible` | بعد server policy | Anthropic subset | اختياري | لا يُفترض | لا تفترض أحدث capabilities fields |
| Gemini Native | `gemini_native` | `https://generativelanguage.googleapis.com/v1beta/` | `models/{id}:generateContent` | `models` | `models/{id}:embedContent` حيث يدعم | `supportedGenerationMethods` مفيدة للتصنيف |
| Gemini عبر OpenAI compatibility | `openai_compatible` اختياري | `.../v1beta/openai/` | `chat/completions` | `models` | وفق الواجهة الرسمية | ليس المسار الأساسي لهذا المشروع؛ Native مفضل |

## 2. المصادقة

| Protocol | الاستراتيجية | مصدر القيمة | ممنوع |
|---|---|---|---|
| OpenAI-compatible | `Authorization: Bearer ...` ضمن subset الأساسي | adapter server-side | header name/value من العميل |
| Anthropic-compatible | `x-api-key` وversion headers | adapter/preset server-side | version عشوائية من المستخدم |
| Gemini Native | header الرسمي الموصى به مثل `x-goog-api-key` حيث يقبله endpoint | adapter server-side | query URL مسجل أو مفتاح في العميل |

إن تطلب مزوّد متوافق header إضافياً، لا تسمح `custom headers` عامة. أضف auth strategy typed ومراجعة أمنية أو أجّل ذلك المزوّد.

## 3. اكتشاف النماذج

### 3.1 OpenAI-compatible

الشكل الأدنى المقبول:

```json
{
  "data": [
    {
      "id": "model-id",
      "owned_by": "optional-owner"
    }
  ]
}
```

- `id` هو الحقل الوحيد الضروري.
- `owned_by`, `created` وحقول أخرى اختيارية.
- غياب capabilities ينتج `unknown`.
- 404/405 أو shape غير مدعوم لا يمنع manual model/test.

### 3.2 Anthropic-compatible

- استخدم query pagination الرسمية الفعلية، مثل `after_id`/`before_id`/`limit` إذا كانت هي العقد وقت التنفيذ.
- لا تتجاوز page/model limits حتى لو أعاد المزوّد `has_more` دائماً.
- الحقول الحديثة مثل capabilities/max token limits اختيارية في normalizer.
- لا ترسل cursor عاد من host إلى host آخر.

### 3.3 Gemini Native

- `GET /v1beta/models` مع `pageSize`/`pageToken` ضمن الحدود.
- احتفظ بالهوية الخام `models/...` حيث يلزم.
- صنف Chat إذا تضمنت الطرق `generateContent`، وEmbeddings إذا تضمنت `embedContent`.
- ظهور القدرة في catalog لا يلغي الحاجة إلى اختبار الوصول الفعلي بالمفتاح.

## 4. التوليد: subset المدعوم

### OpenAI-compatible subset

- non-streaming chat completions.
- system + user/assistant messages وفق تطبيع adapter.
- model ID يدوي أو من catalog.
- text output وusage إن توفر.
- لا يلزم في الإصدار الأول: tools، JSON schema، images، audio، reasoning controls، streaming، vendor-specific fields.

إذا رفض مزوّد حقلاً قياسياً مثل `max_completion_tokens` واستخدم بديلاً، يُعالج باختبار وoption/preset typed، لا بفروع تعتمد على string name داخل المستهلك.

### Anthropic-compatible subset

- system prompt منفصل.
- user/assistant content النصي.
- دمج الأدوار المتتابعة إذا كان البروتوكول يفرض التناوب.
- non-streaming text extraction وusage.
- version header مثبت ومراجع.

### Gemini Native subset

- system instruction حيث يدعمه العقد.
- تحويل user/assistant إلى أدوار Gemini الصحيحة.
- استخراج النص من candidates/parts مع معالجة blocked/empty response كخطأ مطبع.
- usage إن توفر.
- لا multimodal/tools/streaming في النطاق الحالي.

## 5. Embeddings

| المصدر | طريقة التحقق | قرار الإصدار الحالي |
|---|---|---|
| OpenAI-compatible | طلب `embeddings` صغير، count/order/finiteness/dimension | يقبل فقط إذا الناتج 1536 |
| Gemini Native | `embedContent`/batch الرسمي وخيار dimension إن كان مدعوماً | يقبل فقط إذا الناتج الفعلي 1536 |
| Anthropic | لا تفترض endpoint أصلياً | اختر اتصال Embeddings آخر |
| Gateway مخصص | لا تعتمد على اسم النموذج أو ادعاء التوافق | probe فعلي ثم 1536 gate |

لا يثبت `GET /models` بُعد المتجه. القياس الفعلي شرط قبل تفعيل الفهرس.

## 6. درجات التوافق

يمكن أن يسجل الاختبار الداخلي نتيجة دون عرض تعقيد زائد للمستخدم:

| الدرجة | المعنى |
|---|---|
| `verified_protocol` | اجتاز fixture/contract الرسمي للمشروع |
| `verified_connection` | نجح اتصال ومصادقة الحساب |
| `verified_model` | نجح طلب فعلي للنموذج المختار |
| `catalog_only` | ظهر في القائمة ولم يختبر |
| `manual_unverified` | أدخله المستخدم ولم يختبر |

هذه حالات مستقلة زمنياً. تغيير المفتاح/root يبطل connection/model verification، وتغيير model يبطل model verification فقط.

## 7. حالات اختلاف متوقعة

- root يتضمن `/v1` أو مسار proxy إضافياً.
- endpoint models غير موجود رغم نجاح chat.
- usage field مختلف أو غائب.
- system role غير مقبول ويحتاج حقلاً منفصلاً.
- اسم assistant role مختلف داخلياً كما في Gemini.
- provider يعيد HTML أو نصاً عند الخطأ.
- status 200 مع response خالٍ أو blocked.
- model catalog يحتوي نماذج لا يملك المفتاح صلاحيتها.
- خدمة تدعي OpenAI-compatible لكنها لا تدعم الحقل المستخدم حالياً.

كل اختلاف يُطبّع داخل adapter/preset option وfixture، لا ينتشر إلى UI أو domain consumers.

## 8. إضافة preset جديد

قبل الإضافة، أجب ووثق:

1. ما protocol والـ subset المثبت؟
2. ما API root الرسمي وهل هو ثابت؟
3. ما auth strategy؟
4. هل models endpoint موجود؟ وما pagination/limits؟
5. هل metadata تصف القدرات أم تبقى unknown؟
6. هل chat fixture ينجح بالعقد الحالي؟
7. هل provider error ينقح بأمان؟
8. هل عنوانه عام أم يحتاج deployment opt-in؟
9. هل Embeddings موجودة وما dimension الفعلية؟
10. ما وثيقة المصدر وتاريخ التحقق؟

إذا كانت الإجابات 1–7 لا تتطلب wire contract جديداً، فالعمل preset + tests. إذا تغير wire contract جذرياً، اكتب ADR وadapter جديداً.

## 9. المراجع الرسمية

- OpenAI List Models: <https://developers.openai.com/api/reference/resources/models/methods/list/>
- Anthropic List Models: <https://platform.claude.com/docs/en/api/models/list>
- Gemini Models API: <https://ai.google.dev/api/models>
- Gemini OpenAI compatibility: <https://ai.google.dev/gemini-api/docs/openai>
- Gemini partner integration: <https://ai.google.dev/gemini-api/docs/partner-integration>
- DeepSeek API: <https://api-docs.deepseek.com/>
- DeepSeek List Models: <https://api-docs.deepseek.com/api/list-models/>
- 9Router: <https://github.com/decolua/9router>

