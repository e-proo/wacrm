# برومبت المرحلة 04 — Anthropic وGemini Native

```text
نفّذ المرحلة 04 فقط بعد استقرار العقود وخدمة الاتصالات. الهدف الحفاظ على Anthropic الحالي داخل المعمارية الجديدة وإضافة Gemini Native للتوليد واكتشاف النماذج. لا تحول Embeddings/pgvector بعد.

قبل الكود:
- راجع وثائق Anthropic وGemini الرسمية الحالية، وسجل تاريخ المراجعة وروابط endpoints/headers/pagination.
- قارن العقد الفعلي مع fixtures الموجودة، ولا تعتمد على الذاكرة أو أسماء نماذج ثابتة.
- أكد قرار النطاق بشأن Custom Anthropic-compatible؛ إن لم يعتمد، نفذ Anthropic preset الثابت فقط.

المطلوب لـ Anthropic:
- adapter مسجل تحت protocol مناسب ويحافظ على سلوك التوليد الحالي.
- auth/version headers server-defined.
- normalization للرسائل المتتابعة كما يتطلب API، مع characterization regression.
- usage input/output إلى العقد العام.
- list models مع pagination الرسمية وحدود pages/models/bytes/time.
- capabilities الرسمية تستخدم إن وجدت، وإلا unknown.
- لا تفترض أن كل Anthropic-compatible gateway يملك أحدث حقول Anthropic.

المطلوب لـ Gemini Native:
- adapter Native مستقل، لا تمرير Gemini داخل OpenAI adapter في هذا النطاق.
- endpoint generation الرسمي وmapping system/messages/response/usage/errors.
- list models Native مع pageToken/nextPageToken والحدود.
- احتفظ بالـ raw provider ID عند الحاجة وطبّع model ID للاستخدام الصحيح دون double prefix أو فقد path.
- استخدم supportedGenerationMethods لتصنيف generateContent/embedContent حين توفر، لا name heuristics كحكم.
- عرّف embed method seam/contract إن كان مناسباً، لكن لا تفعّل كتابة vectors أو تغير config في هذه المرحلة.
- auth key server-side، ولا يظهر في URL logs أو errors.

السلوك المشترك:
- كل الطلبات عبر outbound policy/transport وtimeouts/size limits/redaction.
- model catalog advisory وmanual entry مستمر.
- verify connection منفصل عن test model.
- no automatic generation retry.
- لا تضف streaming/tools/multimodal.

الاختبارات الإلزامية:
- Anthropic request shape، consecutive roles، usage، errors، timeout.
- Anthropic one/multi-page catalog وcapabilities missing/present والحد الأقصى.
- Gemini system/messages/request path/response candidate extraction/empty or blocked response.
- Gemini `models/...` normalization وعدم double prefix.
- Gemini multi-page models وsupportedGenerationMethods.
- auth redaction، provider malformed/401/429/5xx.
- Registry/preset routing وعدم إضافة brand switch للمستهلكين.
- current Anthropic regression.

الوثائق:
- حدث add-provider guide والعقد المدعوم.
- سجل أي اختلاف عن الوثائق الرسمية في ADR أو provider compatibility note.
- لا تسجل response حقيقياً قد يحتوي معلومات حساب؛ أنشئ fixtures مصغرة منقحة.

شغّل التحقق الكامل، واكتب phase-04-anthropic-gemini.md وفق القالب مع روابط المصادر الرسمية وتاريخ التحقق ونتائج الاختبارات. توقف ولا تبدأ المرحلة 05.
```

## بوابة القبول

- Anthropic الحالي بلا انحدار.
- Gemini يستخدم Native adapter واختبارات لا شبكة حقيقية.
- pagination والقدرات والتطبيع موثقة ومحدودة.
- السر لا يظهر في URL مسجل أو public error.

