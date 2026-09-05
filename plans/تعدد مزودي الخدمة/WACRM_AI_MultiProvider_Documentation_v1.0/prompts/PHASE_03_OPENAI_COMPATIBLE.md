# برومبت المرحلة 03 — OpenAI-compatible وكتالوج النماذج

```text
نفّذ المرحلة 03 فقط بعد قبول Connections/Outbound policy. الهدف جعل OpenAI adapter عاماً ضمن subset موثق، وإضافة presets متوافقة واكتشاف نماذج اختياري مع cache. لا تضف Gemini أو تغير نظام embeddings بعد.

المطلوب:

1) OpenAI-compatible adapter
- اجعل API root يأتي من RuntimeConnection المراجع، لا request body.
- ابنِ endpoints نسبياً مع preserving root path ومنع /v1/v1.
- حافظ على OpenAI الحالي request/usage/error behavior.
- عرّف subset المدعوم بوضوح: chat completions غير متدفق وlist models إن وجد. لا تعد بتوافق كل extension.

2) Presets
- OpenAI preset ثابت.
- DeepSeek preset ثابت بعد التحقق من الوثيقة الرسمية وقت التنفيذ.
- أضف OpenRouter أو غيره فقط إن كان ضمن النطاق المعتمد، لا لأن البنية تسمح به.
- Custom OpenAI-compatible مرتبط بسياسة deployment؛ off إن لم توجد حماية كافية.
- 9Router/private gateway يظهر فقط مع deployment opt-in وallowlist، ولا تغير قاعدة منع private endpoints العامة.

3) Model discovery
- طبق listModels كقدرة اختيارية.
- OpenAI-like response normalization إلى ModelInfo.
- لا تعتبر غياب metadata عدم دعم chat/embeddings؛ استخدم unknown.
- endpoint 404/405/unsupported ينتج حالة اكتشاف غير متاحة مع بقاء manual model، لا يحذف الاتصال.
- bounded count/bytes/time/pagination إن كان المزود يضيفه.
- dedupe/stable sort مع حفظ IDs case-sensitive كما هي.

4) Cache/invalidation
- احفظ normalized bounded catalog وfetched_at.
- cache key/freshness مربوطان بـ connection fingerprint وadapter catalog version.
- refresh failure يبقي آخر نجاح ويضع stale/error code.
- key/root/protocol change invalidates freshness.
- لا refresh ضمن generation أو كل UI render.

5) Verify vs test
- discover/auth state منفصلة عن selected-model generation test.
- model test طلب صغير، صريح، server-side، rate-limited، بلا بيانات عميل، ولا يتكرر عند تعديل system prompt/toggle فقط.
- لا retry تلقائياً للتوليد.

6) API وDTO
- endpoint discover-models وtest-model أو ما يطابق convention المشروع.
- response آمن بالحالة والكتالوج/error envelope/request ID.
- current saved model لا يُرفض فقط لأنه غير موجود في أحدث catalog.

الاختبارات الإلزامية:
- roots مع وبدون trailing slash ومسار /v1 وcustom path.
- OpenAI regression.
- DeepSeek-like fixture يعمل عبر adapter نفسه، بلا brand branch في generate.
- models 404 + manual chat success.
- malformed/oversize/timeout/401/429/500.
- stale-on-error وعدم مسح saved model.
- fingerprint invalidation وconcurrent refresh coalescing/limit.
- fixed preset cannot be overridden.
- local/private preset blocked unless deployment opt-in fixture.
- no provider raw body/secret in response/log.

وثّق:
- subset التوافق المدعوم.
- إضافة preset جديد لبروتوكول قائم.
- إعداد private gateway في self-hosted والمخاطر، إذا نُفذ.
- لا تستخدم أسماء نماذج hard-coded كقائمة سماح.

شغّل التحقق الكامل واكتب phase-03-openai-compatible.md وفق القالب. اذكر URLs الرسمية التي تحققت منها وتاريخها، لكن لا تضع مفاتيح. توقف ولا تبدأ المرحلة 04.
```

## بوابة القبول

- إضافة preset متوافق لا تحتاج تغيير generate logic.
- `/models` اختياري وmanual path مختبر.
- cache/stale/invalidation صحيحة.
- OpenAI القديم لم ينكسر.

