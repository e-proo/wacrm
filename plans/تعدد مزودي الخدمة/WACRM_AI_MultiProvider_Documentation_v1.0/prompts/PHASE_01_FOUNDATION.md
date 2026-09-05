# برومبت المرحلة 01 — العقود وRegistry مع الحفاظ على السلوك

```text
نفّذ المرحلة 01 فقط بعد اعتماد تقرير المرحلة 00 بحالة GO. هدفك refactor سلوكي محايد: تأسيس ProviderAdapter/Registry والعقود المشتركة، مع إبقاء المزوّدات الفعلية OpenAI وAnthropic وسلوك المستهلكين كما هو.

اقرأ تقرير المرحلة 00 والوثائق تحت docs/ai-multi-provider، ثم أعد ذكر الافتراضات المؤثرة باختصار قبل التعديل. احترم التغييرات المحلية ولا توسع النطاق.

المطلوب:

1) اختبارات characterization أولاً
- ثبت سلوك generateReply الحالي لـ OpenAI وAnthropic، بما فيه request shape، system prompt، consecutive-role normalization إن وجد، usage mapping، timeouts، errors، handoff sentinel.
- استخدم HTTP mocks/transport قابل للاختبار؛ لا مفاتيح أو اتصالات حقيقية.

2) العقود
- عرف ProviderProtocol وProviderAdapter والطلبات/النتائج العامة وفق TARGET_ARCHITECTURE، مع تكييف الأسماء لبنية المشروع.
- capability state ثلاثية، لكن لا تبنِ UI أو catalog بعد.
- أبق generate غير متدفق؛ لا تضف streaming/tools/function calling/multimodal.
- لا تجعل apiKey جزءاً من client type.

3) Registry
- أنشئ registry server-side ثابتاً يحل protocol إلى adapter.
- حوّل OpenAI وAnthropic الحاليين إلى adapters أو لفهما بش shim نظيف.
- استبدل switch المركزي بregistry resolution مع unsupported-protocol error مطبع.
- لا تضف brand cases مثل DeepSeek الآن.

4) Shared network/error helpers
- استخرج التكرار الضروري فقط: timeout/network classification/provider response parsing/usage normalization.
- حافظ على URLs الثابتة الحالية في هذه المرحلة؛ لا تقبل base URL من request.
- لا تمرر response body الخام إلى public error. إن كان السلوك الحالي يفعل ذلك، أصلحه مع regression tests واذكره كتقسية أمنية لازمة، مع الحفاظ قدر الإمكان على public codes.

5) التوافق
- أبق public call sites وتوقيعاتها أو أضف compatibility facade لتقليل diff.
- لا migration ولا تعديل config schema/UI/embeddings.

الاختبارات المطلوبة:
- Registry resolves both protocols and rejects unknown.
- OpenAI and Anthropic adapter contract fixtures.
- Network timeout/malformed/error mapping.
- Usage and handoff regression.
- Assert provider call count one; no automatic generation retry.
- Assert secrets/provider raw body are absent from public errors/logs.

التحقق:
- شغّل الاختبارات المستهدفة أثناء العمل.
- في النهاية شغّل scripts الفعلية: format check، lint، typecheck، full test، build حيث تسمح البيئة.
- لا تصلح أخطاء unrelated إلا إذا كانت تمنع التحقق؛ وثقها.

المخرجات:
- كود واختبارات المرحلة فقط.
- تحديث وثيقة architecture إذا اختلف اسم/عقد غير جوهري.
- تقرير phase-01-foundation.md وفق القالب، مع before/after call graph ونتائج الأوامر وrollback.

معيار التوقف:
- إذا احتاج refactor تغيير schema أو public behavior كي ينجح، توقف واشرح القرار المطلوب.
- لا تبدأ المرحلة 02.
```

## بوابة القبول

- لا `switch` باسم المزوّد في مسار التوليد المركزي.
- لا تغيّر observable behavior للمزوّدين الحاليين إلا تنقيح تسرب موثق.
- لا ملفات migration/UI أو مزوّد جديد.
- tests الحالية والجديدة تمر.

