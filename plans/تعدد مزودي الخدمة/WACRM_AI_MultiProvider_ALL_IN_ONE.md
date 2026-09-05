# توثيق WACRM الشامل لتعدد اتصالات ومزوّدي الذكاء الاصطناعي — نسخة موحدة

**الإصدار:** 1.0  
**التاريخ:** 2026-09-03  
**ملاحظة:** هذه نسخة قراءة موحدة تجمع المواصفات والعمارة والأمن والاختبارات وخطة التنفيذ والبرومبتات والقوالب. عند التطبيق العملي، يُفضل استخدام الحزمة المقسمة لأن كل مرحلة فيها ملف مستقل أسهل للمراجعة والتسليم إلى وكيل البرمجة.

---

# المواصفات الرئيسية لتعدد اتصالات ومزوّدي الذكاء الاصطناعي في WACRM

**معرّف الوثيقة:** WACRM-AI-MP-001  
**الإصدار:** 1.0  
**التاريخ:** 2026-09-03  
**الحالة:** مواصفات تنفيذ معتمدة مبدئياً  
**اللغة:** العربية، مع إبقاء العقود البرمجية والمصطلحات التقنية بالإنجليزية عند الحاجة

------------------------------------------------------------------------

## 1. الملخص التنفيذي

الهدف هو تحويل تكامل الذكاء الاصطناعي في WACRM من اختيار ثابت بين OpenAI وAnthropic إلى منظومة اتصالات مرنة وآمنة تسمح بما يلي:

- استخدام OpenAI وAnthropic دون كسر السلوك الحالي.
- إضافة Gemini من خلال مهايئ Native واضح، مع إمكانية الاستفادة من واجهته المتوافقة مع OpenAI عند الضرورة فقط.
- إضافة DeepSeek وأي خدمة تتبع عقد OpenAI-compatible من دون بناء مهايئ خاص لكل علامة تجارية.
- دعم الخدمات التي تتبع عقد Anthropic-compatible عند الحاجة.
- دعم بوابات محلية أو وسيطة مثل 9Router ضمن سياسة نشر صريحة وآمنة، لا عبر فتح عناوين داخلية لجميع المستخدمين.
- جلب قائمة النماذج ديناميكياً من المزوّد عند الإمكان، مع بقاء الإدخال اليدوي متاحاً دائماً.
- فصل اتصال المحادثة عن اتصال Embeddings حتى لا يُجبر المستخدم على استعمال المزوّد نفسه لكليهما.
- الحفاظ على أمان مفاتيح BYOK، وعزل الحسابات، ومنع SSRF، وتوحيد الأخطاء، وإضافة اختبارات وتشغيل قابل للرصد.

التصميم المقترح لا يربط النظام بأسماء مزوّدين متزايدة داخل `switch`، بل يفصل بين ثلاثة مفاهيم:

1.  **Connection:** إعداد محفوظ لحساب معيّن، يحوي اسم الاتصال والبروتوكول و`base URL` والسر المشفر.
2.  **Protocol adapter:** تنفيذ عقد تقني مثل `openai-compatible` أو `anthropic-compatible` أو `gemini-native`.
3.  **Provider preset:** إعداد تجربة المستخدم لمزوّد معروف مثل OpenAI أو DeepSeek، يحدد القيم الافتراضية والسياسات من دون تكرار المهايئ.

هذه الوثيقة هي المرجع الأعلى للفكرة. التفاصيل الموسعة موجودة في ملفات الحزمة، والبرومبتات المرحلية تمنع تنفيذ المشروع دفعة واحدة بطريقة يصعب تدقيقها أو الرجوع عنها.

------------------------------------------------------------------------

## 2. المشكلة الحالية

بحسب لقطة مرجعية من الفرع العام لـ WACRM بتاريخ هذه الوثيقة، يوجد دعم BYOK لـ OpenAI وAnthropic، لكن التوسعة تواجه القيود التالية:

- النوع `AiProvider` محصور في `'openai' | 'anthropic'`.
- اختيار المزوّد يتم داخل `generateReply` بواسطة `switch`.
- عناوين API ثابتة داخل المهايئات.
- اسم النموذج حقل نصي حر، ولا توجد آلية اكتشاف نماذج موحدة.
- Embeddings مرتبطة بمفتاح OpenAI منفصل، ونموذج ثابت، وبُعد ثابت `1536`.
- جدول `ai_configs` يجمع سلوك المساعد والاختيار والمفاتيح في سجل واحد لكل حساب.
- اختبار الإعداد يعتمد على طلب توليد حقيقي، ولا يفصل بين صلاحية الاتصال وصلاحية نموذج بعينه.
- قبول `base URL` مخصص من المستخدم سيضيف سطح SSRF جديداً لم يكن موجوداً عند استخدام عناوين ثابتة.

هذه اللقطة ليست بديلاً عن فحص فرع العمل الحقيقي. يجب على المنفّذ إعادة الاستكشاف قبل كتابة أي كود؛ فقد تتغير الملفات والمخططات والـ APIs أو توجد تغييرات محلية أو PR متداخل.

------------------------------------------------------------------------

## 3. أهداف المنتج

### 3.1 أهداف إلزامية

| المعرّف | الهدف                                                                     |
|--------|---------------------------------------------------------------------------|
| OBJ-01 | المحافظة على إعدادات OpenAI وAnthropic الحالية وسلوكها أثناء الترحيل      |
| OBJ-02 | تمكين مزوّدات OpenAI-compatible من خلال مهايئ مشترك و`base URL` مضبوط      |
| OBJ-03 | دعم Gemini Native بعقد منفصل وقابل للاختبار                               |
| OBJ-04 | اكتشاف النماذج ديناميكياً عندما يعلن المزوّد ذلك، مع إدخال يدوي دائم        |
| OBJ-05 | فصل إعدادات Chat وEmbeddings واختيار كل منهما بشكل مستقل                  |
| OBJ-06 | عدم كشف مفاتيح API أو تفاصيل حساسة في العميل أو السجلات أو رسائل الخطأ    |
| OBJ-07 | منع SSRF وDNS rebinding وإساءة استخدام المسارات وإعادة التوجيه            |
| OBJ-08 | توفير ترحيل تدريجي قابل للرجوع من دون فقد إعدادات حالية                   |
| OBJ-09 | توفير عقود واختبارات ووثائق تجعل إضافة بروتوكول لاحق عملية محدودة وواضحة  |
| OBJ-10 | توفير تجربة إعداد توضح حالة الاتصال، عمر قائمة النماذج، وفشل كل خطوة بدقة |

### 3.2 أهداف جودة

- لا تُضاف تبعية تشغيلية جديدة بلا حاجة موثقة.
- لا توجد اتصالات خارجية من المتصفح إلى مزوّد الذكاء الاصطناعي.
- لا توجد أسماء نماذج إلزامية hard-coded كقائمة سماح عامة.
- لا تؤدي إضافة preset جديد إلى تعديل منطق التوليد إن كان يستخدم بروتوكولاً موجوداً.
- لا تؤدي مشكلة اكتشاف النماذج إلى فقد اختيار المستخدم أو تعطيل الإدخال اليدوي.
- تكون كل مرحلة قابلة للاختبار والعرض والرجوع بصورة مستقلة.

### 3.3 خارج النطاق في هذا الإصدار

- بناء وكيل أدوات عام أو function calling أو agent orchestration.
- إعادة تصميم نظام الردود الآلية أو Sentinel الخاص بالتحويل إلى موظف.
- إضافة streaming لمجرد أنه مدعوم لدى مزوّد ما؛ الواجهة الحالية غير متدفقة، ويمكن إضافته لاحقاً بقرار مستقل.
- إدارة فوترة المزوّدات أو شراء أرصدة أو تخزين مفاتيح مركزية بالنيابة عن العملاء.
- دعم كل اختلاف غير قياسي لخدمة تدّعي توافق OpenAI أو Anthropic.
- تغيير أبعاد pgvector بلا خطة إعادة فهرسة مستقلة ومختبرة.
- النشر إلى الإنتاج أو تشغيل migration إنتاجي تلقائياً.

------------------------------------------------------------------------

## 4. مصطلحات ملزمة

| المصطلح                 | التعريف                                                                                        |
|-------------------------|------------------------------------------------------------------------------------------------|
| Connection              | إعداد حساب محفوظ للوصول إلى API، يشمل البروتوكول وAPI root والسر المشفر والسياسة               |
| Adapter                 | كود يحوّل عقد WACRM الداخلي إلى بروتوكول مزوّد محدد ويطبّع النتيجة                                |
| Preset                  | تعريف غير سري لمزوّد معروف: الاسم، البروتوكول، API root الافتراضي، وإمكانات الاكتشاف            |
| Custom connection       | اتصال يسمح بعنوان مخصص ضمن سياسة النشر، وليس عنواناً حراً غير مقيد                               |
| Model catalog           | قائمة مؤقتة وإرشادية للنماذج التي أعادها المزوّد، وليست ضماناً لقدرتها أو توفرها                 |
| Capability              | قدرة معلنة أو مكتشفة مثل chat أو embeddings، وقيمتها `supported` أو `unsupported` أو `unknown` |
| Verification            | فحص مصادقة/وصول أو فحص نموذج مختار، وتُحفظ نتائجهما منفصلة                                      |
| Semantic index revision | هوية النموذج والبُعد والإعدادات التي أُنشئت بها متجهات قاعدة المعرفة                             |

------------------------------------------------------------------------

## 5. مبادئ التصميم

### 5.1 البروتوكول ليس العلامة التجارية

DeepSeek وOpenRouter و9Router وأي خدمة قياسية أخرى لا تحتاج ملفات توليد مكررة إن كانت تتبع عقد OpenAI. يجب أن يحدد preset تجربة المستخدم، بينما يحدد adapter البروتوكول.

### 5.2 الاكتشاف قدرة اختيارية

ليست كل خدمة متوافقة تطبق `GET /models` أو تعيد بيانات كافية لتحديد الغرض. لذلك:

- تكون `listModels` اختيارية في العقد.
- الفشل فيها لا يجعل الاتصال غير صالح تلقائياً.
- الإدخال اليدوي للنموذج متاح دائماً.
- قائمة النماذج ليست allowlist للتوليد.

### 5.3 الفشل الآمن مع المحافظة على عمل المستخدم

عند فشل تحديث الكتالوج، يحتفظ النظام بآخر نسخة ناجحة ويعرض أنها قديمة. لا يمسح النموذج المحفوظ، ولا يستبدله بأول عنصر في القائمة الجديدة، ولا يحذف المفتاح.

### 5.4 السر يبقى على الخادم

العميل يستقبل `has_key` وحالة التحقق فقط. المفتاح المشفر أو المفكوك لا يظهر في JSON أو HTML أو Local Storage أو URL أو logs.

### 5.5 التوافق الخلفي قبل النظافة النظرية

تُنفذ قاعدة البيانات بنمط expand → migrate → switch reads/writes → contract لاحق. لا تُحذف أعمدة قديمة في الإصدار نفسه الذي يبدأ القراءة من البنية الجديدة.

### 5.6 العقود صغيرة بقدر الحاجة الحالية

المطلوب الآن توليد غير متدفق وEmbeddings واكتشاف نماذج اختياري. لا يفرض العقد streaming أو tools أو multimodal قبل وجود مستهلك حقيقي لها.

------------------------------------------------------------------------

## 6. خط الأساس المرجعي للمستودع

تمت مراجعة المستودع العام `ArnasDon/wacrm` كمرجع فقط عند الالتزام `98b5bd26e8feacacfd4b74ff58411acb8154d212`، وكانت أهم الملاحظات:

- Next.js 16 وReact 19 وTypeScript وSupabase وVitest.
- مزوّدا Chat حاليان تحت `src/lib/ai/providers/`.
- التوجيه في `src/lib/ai/generate.ts`.
- Embeddings في `src/lib/ai/embeddings.ts`، باستخدام `text-embedding-3-small` و`1536` بُعداً.
- جداول ووظائف pgvector في migrations الخاصة بالذكاء الاصطناعي، ومنها migration 030.
- API إعدادات الذكاء الاصطناعي تحت `src/app/api/ai/config/route.ts`.
- واجهة الإعدادات تحت `src/components/settings/ai-config.tsx`.
- مفاتيح BYOK مشفرة باستخدام مسار التشفير الحالي.
- المشروع يحتوي تعليمات محلية تطلب قراءة وثائق Next.js الموجودة في `node_modules` قبل تعديل سلوك الإطار.

### قاعدة ملزمة للمنفّذ

لا يُنسخ هذا الخط الأساس إلى الكود كافتراض. يجب تنفيذ المرحلة صفر على الفرع الفعلي وتوثيق:

- الالتزام الحالي والفرع وحالة `git status`.
- أي ملفات معدّلة من المستخدم وعدم الكتابة فوقها.
- أحدث migration ورقم migration الجديد الصحيح.
- العقود ومسارات الاستدعاء الحالية الفعلية.
- أي PR أو فرع محلي يضيف مزوّدات أو يعيد بناء AI.
- أوامر التحقق الموجودة في `package.json`.

------------------------------------------------------------------------

## 7. المتطلبات الوظيفية

### 7.1 إدارة الاتصالات

| المعرّف    | المتطلب                                                                          | الأولوية |
|-----------|----------------------------------------------------------------------------------|----------|
| FR-CON-01 | يستطيع Admin إنشاء اتصال باسم واضح واختيار preset                                | Must     |
| FR-CON-02 | يشتق النظام protocol وAPI root وسياسة المصادقة من preset                         | Must     |
| FR-CON-03 | يمكن تعديل API root فقط لاتصال Custom وضمن سياسة الخادم                          | Must     |
| FR-CON-04 | يمكن استبدال المفتاح أو مسحه من خلال فعل صريح، ولا يعاد عرضه                     | Must     |
| FR-CON-05 | لا يستطيع المستخدم تحويل preset ثابت إلى عنوان داخلي عبر payload معدل            | Must     |
| FR-CON-06 | يمكن للحساب امتلاك أكثر من اتصال محفوظ واختيار واحد للمحادثة وآخر للـ Embeddings | Should   |
| FR-CON-07 | حذف اتصال مستخدم في إعداد نشط يتطلب فك الارتباط أو تأكيداً ومعاملة ذرية           | Must     |
| FR-CON-08 | أعضاء الحساب يقرؤون metadata آمنة فقط؛ Admin فأعلى يعدّلون الأسرار                | Must     |

### 7.2 اكتشاف النماذج

| المعرّف    | المتطلب                                                                   | الأولوية |
|-----------|---------------------------------------------------------------------------|----------|
| FR-MOD-01 | زر صريح «تحقق واجلب النماذج» ينفذ الاستدعاء من الخادم                     | Must     |
| FR-MOD-02 | يدعم OpenAI-compatible `GET models` عند توفره                             | Must     |
| FR-MOD-03 | يدعم Anthropic pagination ويجمع الصفحات ضمن حد آمن                        | Must     |
| FR-MOD-04 | يدعم Gemini Native ونزع بادئة `models/` عند حفظ اسم التوليد إن تطلب العقد | Must     |
| FR-MOD-05 | يطبّع النتائج إلى عقد داخلي واحد ويزيل التكرار ويرتبها بثبات               | Must     |
| FR-MOD-06 | يحتفظ بآخر كتالوج ناجح وبوقت جلبه، ويعرض stale عند فشل التحديث            | Must     |
| FR-MOD-07 | يسمح دائماً بإدخال اسم نموذج يدوياً حتى إن نجح الاكتشاف                     | Must     |
| FR-MOD-08 | لا يخفي نموذجاً مجهول القدرة اعتماداً على الاسم فقط؛ يمكن تصنيفه `unknown`  | Must     |
| FR-MOD-09 | يحد حجم الصفحات والصفوف والـ response bytes والمهلة                       | Must     |
| FR-MOD-10 | لا يجلب تلقائياً مع كل render أو كل ضغطة مفتاح                             | Must     |

### 7.3 التحقق والحفظ

- **فحص الاتصال/الكتالوج:** يثبت أن العنوان والمصادقة وendpoint الاكتشاف يعملون؛ لا يثبت صلاحية Chat لنموذج معين.
- **فحص النموذج المختار:** طلب صغير صريح إلى endpoint التوليد؛ قد يستهلك حصة أو مالاً، لذلك لا يتكرر عند حفظ إعدادات سلوكية لم تتغير.
- تغيير المفتاح أو API root أو protocol يلغي نتيجة التحقق السابقة ويجعل الكتالوج stale.
- تغيير model يلغي `generation_verified_at` فقط.
- لا تُحفظ نتيجة success إن تغيرت بصمة الاتصال بين بداية الطلب ونهايته.
- عند عدم وجود endpoint اكتشاف، يمكن اختبار نموذج يدوي ثم الحفظ.
- الحفظ لا يعتبر نجاحاً جزئياً: إما تُحفظ الروابط والإعدادات المتوافقة معاً، أو تُرجع رسالة آمنة بلا حالة هجينة.

### 7.4 التوليد

- يحتفظ المستهلك الحالي بعقد Provider-neutral.
- يختار Registry المهايئ بناء على protocol المخزن، لا على نص العلامة التجارية.
- يجب أن يدعم العقد الحالي: system prompt، رسائل `user/assistant`، اسم النموذج، timeout، وتطبيع usage.
- يحافظ Anthropic adapter على دمج الأدوار المتتابعة إن كان API يتطلب التناوب.
- يحافظ مسار التوليد على parsing الحالي لعلامة handoff.
- يمنع إرسال طلب إذا كان الاتصال غير فعال، أو المفتاح غير قابل للفك، أو model فارغاً.
- retries لتوليد الرد معطلة افتراضياً لتجنب تكرار التكلفة أو الرد، إلا إذا وُجدت آلية idempotency موثوقة وقرار مستقل.

### 7.5 Embeddings وقاعدة المعرفة

هذه المنطقة لها قيد سلامة بيانات لا يجوز تجاوزه: المخطط المرجعي الحالي يستخدم `vector(1536)` وفهرساً مبنياً لهذا البُعد.

لذلك، في هذا الإصدار:

1.  يختار المستخدم اتصال Embeddings مستقلاً عن Chat.
2.  لا يظهر نموذج Embeddings كصالح لمجرد وجود اسمه في `/models`.
3.  عند التحقق، يُرسل إدخال صغير ثم يُقاس طول المتجه فعلياً.
4.  لا يُقبل النموذج لمسار قاعدة المعرفة الحالي إلا إذا أعاد بالضبط `1536` بعد تطبيق خيار أبعاد رسمي مدعوم لدى المزوّد.
5.  لا تُقصّر المتجهات ولا تُملأ بأصفار محلياً.
6.  يُحفظ `embedding_model` و`embedding_dimensions` و`embedding_revision` مع إعداد الحساب.
7.  تغيير أي من هذه القيم يجعل الفهرس الحالي غير متوافق ويتطلب re-index صريحاً.
8.  أثناء re-index لا تُخلط متجهات مراجعتين في البحث نفسه.
9.  إذا فشل semantic retrieval، يبقى fallback النصي الحالي متاحاً وفق السلوك القائم.

دعم أبعاد متعددة في قاعدة البيانات مشروع تالٍ. يتطلب فهارس منفصلة أو تخطيطاً متوافقاً مع قيود pgvector؛ لا يُحل بتخزين متجهات مختلفة الطول في الفهرس نفسه.

------------------------------------------------------------------------

## 8. المتطلبات غير الوظيفية

### 8.1 الأمن

- تشفير الأسرار at rest باستخدام الآلية الحالية المراجعة أو نسخة محسنة ذات versioning.
- TLS عام إلزامي للاتصالات المخصصة في النشر المستضاف.
- عناوين preset ثابتة على الخادم وغير قابلة للتجاوز من payload العميل.
- سياسة outbound مركزية تشمل DNS، IP ranges، ports، redirects، timeout، وحجم الرد.
- RLS وعزل كامل بـ `account_id`.
- لا تُسجل prompts أو محادثات أو مفاتيح أو Authorization headers.
- رسائل خطأ للمستخدم لا تتضمن provider body الخام.
- تدقيق أفعال إنشاء/تعديل/اختبار/حذف الاتصال من دون قيمة السر.

### 8.2 الأداء والاعتمادية

- اكتشاف النماذج عملية عند الطلب مع cache وTTL، وليس ضمن مسار توليد الرد.
- timeout منفصل لكل من connect/read/overall إن سمحت المكتبة المستخدمة.
- حد أقصى للصفحات والنماذج وحجم JSON.
- concurrency limit لكل حساب/اتصال.
- استخدام آخر كتالوج ناجح عند تعذر التحديث.
- فشل مزوّد واحد لا يؤثر على بقية الاتصالات.

### 8.3 القابلية للصيانة

- لا يكون للـ UI علم بتفاصيل headers أو paths الخاصة بكل مزوّد.
- لا تكرر المهايئات تطبيع الشبكة والأخطاء.
- كل preset declarative قدر الإمكان.
- العقود العامة موثقة ومغطاة باختبارات contract.
- أي استثناء غير قياسي لخدمة معينة يُعزل في preset hook أو adapter extension موثق.

------------------------------------------------------------------------

## 9. العمارة المستهدفة

``` mermaid
flowchart TD
  UI["Settings UI"] --> API["Server API"]
  API --> CS["Connection Service"]
  API --> AS["AI Service"]
  CS --> POLICY["Outbound URL Policy"]
  CS --> REG["Provider Registry"]
  AS --> REG
  REG --> OA["OpenAI-compatible Adapter"]
  REG --> AN["Anthropic Adapter"]
  REG --> GE["Gemini Native Adapter"]
  CS --> DB[("Supabase")]
  AS --> DB
```

### 9.1 الطبقات

1.  **UI:** يرسل intent فقط: preset، اسم اتصال، سر جديد اختياري، نموذج مختار.
2.  **Route/service layer:** المصادقة، الدور، validation، rate limits، والمعاملات.
3.  **Connection service:** تحميل metadata، فك السر في الذاكرة، حساب fingerprint، إدارة الكتالوج والتحقق.
4.  **Outbound policy:** التحقق من الوجهة قبل كل اتصال وكل redirect.
5.  **Provider registry:** يحل protocol إلى adapter ويحل preset إلى configuration.
6.  **Adapters:** تحويل الطلب/الرد فقط، من دون وصول مباشر إلى قاعدة البيانات أو session.
7.  **Persistence:** connections وconfig وaudit/cache وفق RLS.

### 9.2 العقود المقترحة

الأسماء التالية توجيهية وتتكيف مع naming المشروع:

``` ts
export type ProviderProtocol =
  | 'openai_compatible'
  | 'anthropic_compatible'
  | 'gemini_native'

export type CapabilityState = 'supported' | 'unsupported' | 'unknown'

export interface ProviderCapabilities {
  chat: CapabilityState
  embeddings: CapabilityState
  modelDiscovery: CapabilityState
}

export interface RuntimeConnection {
  id: string
  accountId: string
  presetId: string
  protocol: ProviderProtocol
  apiRoot: URL
  apiKey: string
}

export interface ModelInfo {
  id: string
  displayName: string
  capabilities: ProviderCapabilities
  inputTokenLimit?: number
  outputTokenLimit?: number
  ownedBy?: string
  rawProviderId?: string
}

export interface ModelCatalog {
  models: ModelInfo[]
  fetchedAt: string
  source: 'provider' | 'cache'
  completeness: 'complete' | 'bounded'
}

export interface GenerateRequest {
  connection: RuntimeConnection
  model: string
  systemPrompt: string
  messages: ChatMessage[]
  timeoutMs: number
}

export interface EmbedRequest {
  connection: RuntimeConnection
  model: string
  inputs: string[]
  dimensions?: number
  timeoutMs: number
}

export interface ProviderAdapter {
  readonly protocol: ProviderProtocol
  generate(request: GenerateRequest): Promise<ProviderResult>
  listModels?: (connection: RuntimeConnection) => Promise<ModelCatalog>
  embed?: (request: EmbedRequest) => Promise<number[][]>
}
```

#### قواعد العقد

- لا يمر `apiKey` في props أو client DTOs.
- لا يقرأ adapter متغيرات session أو قاعدة البيانات.
- `URL` يبنى مرة بعد التحقق، ولا يجري concatenation عشوائي للسلاسل.
- `ModelInfo.capabilities` ثلاثية الحالة؛ `unknown` ليست `unsupported`.
- الحقل `rawProviderId` للتشخيص الداخلي الآمن فقط، ولا يلزم تخزين الاستجابة الخام.
- أي optional method يعني قدرة غير متاحة إن غابت؛ لا ترمِ `not implemented` في المسار العادي.

### 9.3 Registry وPresets

مثال توجيهي:

``` ts
export interface ProviderPreset {
  id: string
  label: string
  protocol: ProviderProtocol
  apiRoot: string
  apiRootMode: 'fixed' | 'custom'
  authMode: 'bearer' | 'x-api-key' | 'query-key'
  availability: 'public' | 'deployment_opt_in'
}
```

قواعد:

- `authMode` لا يرسله العميل؛ يأتي من preset/protocol.
- OpenAI وDeepSeek وOpenRouter قد تكون presets مختلفة فوق adapter واحد.
- 9Router أو عنوان LAN يصنف `deployment_opt_in` ويحتاج allowlist يملكها مشغّل النظام.
- Custom OpenAI-compatible لا يعني السماح بكل host. التخصيص يخضع لسياسة نشر.
- إضافة preset لا تتطلب migration إذا كانت القائمة في الكود، إلا إن تقرر جعلها بيانات إدارية.

### 9.4 بناء URLs

يُعرّف `apiRoot` بأنه جذر API شامل النسخة التي يتطلبها المزوّد، مثل مسار ينتهي بـ `/v1/` أو `/v1beta/`. ثم يبني adapter المسارات النسبية بطريقة موحدة:

``` ts
const endpoint = new URL('chat/completions', ensureTrailingSlash(apiRoot))
```

لا يُفترض أن كل base URL يحتاج إضافة `/v1`. فبعض الخدمات تعطي root يتضمنه، وبعضها يضع مساراً مختلفاً، وإضافته آلياً قد تنتج `/v1/v1` أو تمسح path مهم عند استخدام `new URL` بصورة خاطئة.

------------------------------------------------------------------------

## 10. نموذج البيانات المقترح

### 10.1 جدول `ai_provider_connections`

الأسماء النهائية يحددها فحص المشروع، لكن الحد الأدنى المنطقي:

| العمود                                    | الغرض                                                |
|-------------------------------------------|------------------------------------------------------|
| `id uuid pk`                              | معرّف الاتصال                                         |
| `account_id uuid not null`                | العزل والملكية                                       |
| `name text not null`                      | اسم يراه المستخدم                                    |
| `preset_id text not null`                 | OpenAI/DeepSeek/Custom…                              |
| `protocol text not null`                  | قيمة مقيدة إلى البروتوكولات المدعومة                 |
| `api_root text not null`                  | القيمة المطبعة بعد validation                        |
| `encrypted_api_key text not null`         | السر المشفر فقط                                      |
| `key_fingerprint text null`               | بصمة غير قابلة للعكس للمقارنة والتدقيق، إن لزم       |
| `status text not null`                    | `unverified/verified/error/disabled`                 |
| `catalog jsonb null`                      | كتالوج مطبع محدود الحجم، لا response خام             |
| `catalog_fetched_at timestamptz null`     | حداثة القائمة                                        |
| `catalog_error_code text null`            | رمز آمن لآخر خطأ                                     |
| `verified_at timestamptz null`            | نجاح فحص الاتصال                                     |
| `generation_verified_at timestamptz null` | نجاح نموذج Chat المحدد إن رُبط هنا، أو يحفظ في config |
| `created_by uuid`                         | التدقيق                                              |
| `created_at/updated_at`                   | التتبع                                               |

قيود مقترحة:

- unique للاسم داخل الحساب إن كان UX يعتمد أسماء مميزة.
- `protocol` و`status` لهما CHECK constraints.
- حد لطول name وapi_root والكتالوج عند طبقة التطبيق.
- لا تحفظ headers مخصصة حرة في الإصدار الأول؛ هي قناة سهلة لتسريب أسرار أو تجاوز سياسات.
- إن احتاج النظام headers إضافية، تكون قائمة ثابتة حسب preset ومضافة على الخادم.

### 10.2 تعديل `ai_configs`

يبقى الجدول مسؤولاً عن سلوك المساعد، ويضاف إليه تدريجياً:

- `chat_connection_id`.
- `chat_model` أو إبقاء `model` مؤقتاً أثناء الترحيل.
- `embedding_connection_id`.
- `embedding_model`.
- `embedding_dimensions`.
- `embedding_revision`.
- حالة re-index إن كان النظام يديرها من هنا أو من جدول jobs مستقل.

لا تُحذف `provider/api_key/embeddings_api_key` القديمة في مرحلة التوسعة. تُكتب أداة backfill idempotent تحول كل إعداد قديم إلى اتصال/اتصالين، ثم تتحقق من التكافؤ قبل تحويل القراءة.

### 10.3 كتالوج في عمود أم جدول؟

الافتراضي الموصى به لهذه النسخة هو JSONB محدود داخل الاتصال لأن القائمة cache قابلة للاستبدال ولا تحتاج query علائقية معقدة. يُنقل إلى جدول منفصل فقط إذا ظهرت حاجة حقيقية إلى البحث العالمي أو قوائم ضخمة أو تاريخ إصدارات.

### 10.4 RLS

- كل صف مرتبط بـ `account_id`.
- أعضاء الحساب يمكنهم قراءة view أو RPC آمن لا يتضمن ciphertext.
- Admin فأعلى ينشئ ويعدّل ويختبر ويحذف.
- service role يستخدم فقط في مسارات خادم محددة.
- أي `SECURITY DEFINER` يحدد `search_path` صراحة وتُسحب صلاحية التنفيذ من `PUBLIC` ثم تمنح للأدوار اللازمة فقط.
- اختبارات SQL تثبت أن عضواً من حساب A لا يرى metadata أو status لحساب B.

------------------------------------------------------------------------

## 11. عقود HTTP المقترحة

يمكن تكييفها لمسارات المشروع، لكن يجب فصل المسؤوليات:

| الطريقة والمسار                                | الدور  | الغرض                                |
|------------------------------------------------|--------|--------------------------------------|
| `GET /api/ai/connections`                      | member | metadata آمنة لكل الاتصالات          |
| `POST /api/ai/connections`                     | admin  | إنشاء اتصال، مع سر جديد              |
| `PATCH /api/ai/connections/:id`                | admin  | تعديل الاسم/السر/العنوان المسموح     |
| `DELETE /api/ai/connections/:id`               | admin  | حذف بعد فحص المراجع                  |
| `POST /api/ai/connections/:id/discover-models` | admin  | تحقق اتصال وجلب catalog              |
| `POST /api/ai/connections/:id/test-model`      | admin  | اختبار صريح لنموذج محدد              |
| `GET /api/ai/config`                           | member | إعداد سلوكي آمن وروابط الاتصال       |
| `PATCH /api/ai/config`                         | admin  | حفظ chat/embedding selection والسلوك |

### 11.1 DTO آمن نموذجي

``` json
{
  "id": "uuid",
  "name": "DeepSeek production",
  "preset_id": "deepseek",
  "protocol": "openai_compatible",
  "api_root": "https://api.example.invalid/v1/",
  "has_key": true,
  "status": "verified",
  "catalog_fetched_at": "2026-09-03T10:00:00Z",
  "catalog_stale": false
}
```

ممنوع أن يتضمن DTO: ciphertext، plaintext، Authorization header، provider response raw، resolved IPs الداخلية، stack trace، أو key fingerprint إن كان يمكن إساءة استخدامه.

### 11.2 Contract خطأ آمن

``` json
{
  "error": {
    "code": "AI_MODEL_FORBIDDEN",
    "message": "The selected model is not available for this connection.",
    "retryable": false,
    "request_id": "req_..."
  }
}
```

رموز مقترحة:

- `AI_INVALID_CREDENTIALS`
- `AI_PERMISSION_DENIED`
- `AI_RATE_LIMITED`
- `AI_MODEL_NOT_FOUND`
- `AI_MODEL_FORBIDDEN`
- `AI_UNSUPPORTED_CAPABILITY`
- `AI_CONNECTION_BLOCKED`
- `AI_CONNECTION_TIMEOUT`
- `AI_PROVIDER_UNAVAILABLE`
- `AI_PROVIDER_MALFORMED_RESPONSE`
- `AI_EMBEDDING_DIMENSION_MISMATCH`
- `AI_CONFIG_CONFLICT`
- `AI_INTERNAL_ERROR`

يحفظ الخادم سبباً تقنياً منقحاً مع `request_id`، ويعرض للعميل رسالة مترجمة وآمنة. لا يُمرر body المزوّد الخام حتى لو كان status هو 400.

------------------------------------------------------------------------

## 12. اكتشاف النماذج وتطبيعها

### 12.1 OpenAI-compatible

- يستدعي `GET models` نسبياً إلى API root.
- يتوقع شكلاً قريباً من `{ data: [{ id, owned_by, created }] }`.
- يتعامل مع غياب metadata كحالة طبيعية.
- لا يستنتج Chat/Embeddings على نحو قطعي من الاسم.
- يمكن استخدام heuristics لترتيب الخيارات أو وضع شارات فقط، وتُختبر كوحدة مستقلة، ولا تمنع الإدخال اليدوي.

### 12.2 Anthropic

- يدعم pagination الرسمية مع حد صفحات/نماذج.
- يرسل headers الرسمية من الخادم.
- يستخدم capabilities الرسمية إن كانت موجودة في response، مع fallback إلى `unknown` عند الغياب.
- لا يفترض أن كل خدمة Anthropic-compatible تطبق أحدث حقول Anthropic.

### 12.3 Gemini Native

- يستخدم endpoint النماذج Native.
- يعتمد `supportedGenerationMethods` لتحديد `generateContent` و`embedContent` حيث تتوفر.
- يحافظ على `rawProviderId` مثل `models/...` ويطبع معرّف الاستخدام وفق endpoint.
- يحترم pagination و`nextPageToken`.
- لا يساوي بين وجود النموذج وإتاحة النموذج للمفتاح أو المنطقة؛ الاختبار الفعلي هو الفيصل.

### 12.4 cache

- TTL افتراضي مقترح: 15 دقيقة إلى ساعة، يثبت بالقرار التشغيلي.
- زر refresh يمكن أن يتجاوز TTL ضمن rate limit.
- مفتاح cache: `connection_id + connection_fingerprint + adapter_catalog_version`.
- تغيير السر أو root أو protocol يلغي الكتالوج.
- تحفظ النسخة القديمة عند خطأ مؤقت وتعرض `stale=true` مع آخر وقت نجاح.
- لا تحفظ أكثر من حد معقول، مثل 500 نموذج، قبل قرار واضح لدعم قوائم أكبر.
- لا تحفظ provider payload الكامل؛ فقط الحقول المطبعة اللازمة.

### 12.5 ترتيب وعرض النماذج

ترتيب ثابت مقترح:

1.  النموذج المحفوظ حالياً، حتى إن لم يعد في الكتالوج، مع شارة `Saved / not in latest catalog`.
2.  النماذج التي تعلن القدرة المطلوبة.
3.  النماذج ذات القدرة `unknown`.
4.  النماذج غير المدعومة لا تظهر افتراضياً للغرض الحالي، مع إمكانية عرضها للتشخيص.

لا يُستبدل النموذج تلقائياً بعد refresh، ولا يؤدي اختفاء النموذج من الكتالوج إلى حذف الإعداد.

------------------------------------------------------------------------

## 13. سياسة الاتصالات الخارجية ومنع SSRF

فتح `base URL` مخصص يعني أن خادم WACRM أصبح قادراً على الاتصال بعنوان يختاره المستخدم. هذا يجب أن يعالج كحد أمني مستقل.

### 13.1 السياسة الافتراضية

- presets العامة تستخدم HTTPS وعناوين ثابتة يملكها الكود.
- custom public endpoints: HTTPS فقط، ports مسموحة، host مسموح حسب إعداد deployment.
- localhost وprivate/link-local/metadata/multicast/unspecified/CGNAT محجوبة.
- IPv4-mapped IPv6 والعناوين العشرية/السداسية والحيل المشابهة تُطبع ثم تُفحص.
- يمنع username/password في URL، والـ fragment، والمسارات الأطول من الحد.
- لا تتبع redirects تلقائياً؛ كل `Location` يعاد تحليله وحل DNS له وفحصه.
- يوضع حد لعدد redirects، ويفضل صفر في API presets.
- يجري DNS resolution قبل الاتصال، وتوجد حماية من إعادة الربط؛ في البيئات الحساسة يستخدم egress proxy/firewall كطبقة نهائية.
- لا يثق النظام بـ proxy environment variables غير المراجعة.

### 13.2 حالة 9Router والخدمات المحلية

9Router غالباً يعمل على `localhost` أو شبكة خاصة، لذلك لا يمكن دعم هذا السيناريو بأمان في SaaS متعدد المستأجرين عبر استثناء عام.

التصميم الصحيح:

- الوضع الافتراضي: محجوب.
- self-hosted deployment: يفعّل المشغّل متغيراً/قائمة سماح على مستوى الخادم لوجهات محددة، مثل host وport معروفين.
- لا يستطيع Admin حساب منفرد تجاوز سياسة المشغّل.
- تظهر الواجهة تحذيراً أن الاتصال خاص بالنشر وقد لا يعمل خارج الشبكة.
- تُوثق المخاطر، ويُفضّل شبكة/egress gateway مخصصة بدلاً من السماح العام لعناوين RFC1918.

### 13.3 حدود الموارد

- timeout إجمالي مضبوط.
- حد bytes للرد قبل JSON parse.
- Content-Type المتوقع مع معالجة مزوّدات لا تضبطه بدقة، من دون قبول ملفات ضخمة.
- حد models/pages.
- rate limit لكل user/account/connection/action.
- concurrency limit لمنع fan-out.
- لا retries على 401/403/404 ومعظم 4xx.
- retries محدودة مع jitter فقط لطلبات idempotent مثل list models، ومع احترام `Retry-After`.

------------------------------------------------------------------------

## 14. تجربة المستخدم

### 14.1 شاشة الاتصالات

كل بطاقة اتصال تعرض:

- الاسم وpreset.
- حالة السر كـ `Configured / Not configured` فقط.
- API root؛ للـ preset الثابت يكون read-only.
- حالة الاتصال وآخر تحقق.
- آخر تحديث للكتالوج وحالة fresh/stale/error.
- أفعال: Edit، Verify & load models، Test model، Disable، Delete.

### 14.2 نموذج الإنشاء/التعديل

الترتيب المقترح:

1.  Provider preset.
2.  Connection name.
3.  API root عند Custom فقط.
4.  API key (فارغ عند التعديل مع توضيح أن تركه فارغاً يبقي الحالي).
5.  زر Verify & load models.
6.  نتيجة آمنة واضحة.

لا تُرسل قيمة placeholder مثل `••••••••` إلى الخادم على أنها مفتاح.

### 14.3 إعداد Chat

- اختيار connection.
- قائمة بحث للنماذج إن توفرت.
- خيار `Enter model ID manually` دائم.
- زر Test selected model مع تنبيه أنه قد يستهلك حصة صغيرة.
- إعدادات system prompt وauto-reply وhandoff تبقى مستقلة عن الاتصال.

### 14.4 إعداد Embeddings

- اختيار connection يدعم/قد يدعم Embeddings.
- اختيار/إدخال model.
- عرض البُعد المطلوب `1536` في الإصدار الحالي.
- اختبار يعرض `Compatible: 1536 dimensions` أو خطأ واضح.
- عند تغيير الإعداد، تعرض خطة re-index وحالة التقدم قبل تحويل البحث الدلالي.

### 14.5 الترجمة والوصول

- لا تضاف نصوص hard-coded داخل JSX.
- تحدّث جميع locales القائمة في المشروع، لا الإنجليزية فقط.
- حالات loading/error/success تستخدم نصاً وقارئ شاشة، ولا تعتمد اللون وحده.
- keyboard navigation للقوائم والحوارات.
- رسائل الخطأ تشرح الإجراء التالي من دون كشف تفاصيل حساسة.

------------------------------------------------------------------------

## 15. الترحيل والتوافق الخلفي

### 15.1 نهج expand/migrate/contract

``` mermaid
flowchart LR
  E["Expand schema"] --> B["Backfill connections"]
  B --> D["Dual-read validation"]
  D --> S["Switch reads/writes"]
  S --> C["Contract later"]
```

#### Expand

- إضافة الجداول والأعمدة والقيود وRLS بلا حذف القديم.
- نشر كود يستطيع قراءة القديم والجديد.

#### Backfill

- لكل `ai_configs` قديم، إنشاء connection مطابق لـ provider الحالي.
- فك السر داخل مسار خادم آمن ثم إعادة استخدام ciphertext إن كان التنسيق يسمح، أو فك/إعادة تشفير بدون logging.
- إنشاء اتصال Embeddings مستقل فقط عند وجود مفتاحه.
- العملية idempotent، ويمكن إعادة تشغيلها.
- تسجيل counts فقط، لا الأسرار.

#### Dual-read/validation

- مقارنة نتيجة التحميل من المسارين في الاختبارات وبيئة staging.
- عند غياب البنية الجديدة، fallback مؤقت للقديم.
- writes الجديدة يمكن أن تكون dual-write لفترة قصيرة إذا لزم rollback، لكن يجب تحديد مالك وفترة إزالة واضحة.

#### Switch

- feature flag على مستوى النشر أو الحساب.
- مراقبة أخطاء decrypt/config/provider.
- عدم حذف الأعمدة القديمة.

#### Contract لاحق

- بعد إصدار مستقر وفترة رجوع متفق عليها فقط.
- migration منفصل لحذف ciphertext/أعمدة قديمة.
- backup وتحقق مسبق وموافقة تشغيلية.

### 15.2 قاعدة منع فقد البيانات

لا يجوز لأي migration أن يحذف إعداداً حالياً أو يستبدل model أو يعيد كتابة المفتاح بقيمة placeholder. كل صف قديم إما يتحول بنجاح، أو يبقى قابلاً للقراءة عبر fallback مع تقرير قابل للمعالجة.

------------------------------------------------------------------------

## 16. استراتيجية الاختبار

### 16.1 اختبارات الوحدة

- Registry resolution ورفض protocol مجهول.
- URL joining لكل شكل root ومنع `/v1/v1`.
- normalization لكل مزوّد.
- pagination، deduplication، stable sort، والحدود.
- error mapping وredaction.
- capability tri-state وعدم حجب `unknown`.
- قياس embedding dimensions ورفض mismatch.
- fingerprint invalidation.
- backoff و`Retry-After` للطلبات المسموح بإعادتها.

### 16.2 Contract tests بمزوّد وهمي

خادم HTTP محلي داخل الاختبار يحاكي:

- نجاح OpenAI-compatible.
- غياب `/models` مع نجاح chat.
- response ناقص أو كبير أو بطيء.
- 401، 403، 404، 429، 500.
- pagination Anthropic/Gemini.
- redirect إلى localhost أو metadata IP.
- DNS/address policy بواجهات قابلة للحقن والاختبار من دون اتصال حقيقي.
- model اختفى من القائمة لكنه ما زال محفوظاً.
- embeddings بأبعاد صحيحة وخاطئة.

### 16.3 اختبارات التكامل

- API authorization حسب الدور والحساب.
- عدم وجود الحقول السرية في GET وsnapshots.
- معاملات إنشاء/تعديل وحذف connection.
- migration وbackfill على نسخة بيانات fixture قديمة.
- اختيار Chat وEmbeddings من اتصالين مختلفين.
- fallback lexical عند غياب/فشل semantic path.
- عدم إعادة اختبار provider عند تعديل system prompt فقط، ما لم تتغير بيانات الاتصال/النموذج.

### 16.4 اختبارات UI

- preset ثابت مقابل custom.
- key masked وعدم استرجاعه.
- loading وstale وmanual entry.
- بقاء model المحفوظ بعد refresh فاشل أو اختفائه من catalog.
- منع الحفظ عند تعارض embedding dimension.
- accessibility الأساسية والترجمات.

### 16.5 فحوص الانحدار

- OpenAI الحالي يولد draft كما قبل.
- Anthropic الحالي يولد draft كما قبل.
- auto-reply وhandoff وusage logging لا تتغير.
- معدلات الحد الحالية لا تضعف.
- قاعدة المعرفة lexical والsemantic الحاليان يستمران للحسابات القديمة.

تفاصيل التتبع موجودة في `delivery/TEST_AND_ACCEPTANCE_MATRIX.md`.

------------------------------------------------------------------------

## 17. المراقبة والتشغيل

### 17.1 بيانات مسموحة في telemetry

- request/correlation ID.
- account identifier مموه أو داخلي حسب سياسة المشروع.
- connection ID وpreset/protocol.
- model ID بعد تطبيق سياسة الخصوصية، من دون إدخال المستخدم.
- العملية: discover/test/generate/embed.
- status/error code/latency/retry count.
- usage tokens إذا أعادها المزوّد.
- catalog count وfresh/stale.

### 17.2 بيانات ممنوعة

- API keys أو ciphertext أو headers.
- prompts والرسائل ومحتوى قاعدة المعرفة.
- response body الخام.
- URL يحتوي query secret.
- stack traces في استجابة العميل.

### 17.3 مؤشرات إطلاق

- نسبة نجاح التوليد حسب protocol/preset.
- p50/p95 latency.
- معدل 401/429/timeout/provider malformed.
- نجاح model discovery وعمر cache.
- أخطاء dimension mismatch.
- عدد الحسابات التي بقيت على fallback القديم أثناء الترحيل.

### 17.4 Runbook مختصر

- ارتفاع 401: لا تعطل النظام؛ وجّه الحساب لإعادة إدخال المفتاح، وتحقق من عدم تغير auth contract.
- ارتفاع 429: لا تكرر التوليد عشوائياً؛ اعرض retryable ورسالة مناسبة وراجع limits.
- فشل catalog فقط: استخدم cache القديم واترك manual entry.
- فشل adapter لمزوّد واحد: عطّل preset عبر flag إن توفر، من دون تعطيل OpenAI/Anthropic.
- خطأ migration: أوقف feature flag، ارجع للقراءة القديمة، ولا تحذف البنية الجديدة قبل تحليل البيانات.
- mismatch للمتجهات: أوقف تفعيل semantic revision الجديدة واستمر على الفهرس السابق/lexical.

------------------------------------------------------------------------

## 18. خطة التنفيذ المرحلية

| المرحلة | الهدف                | المخرج الرئيسي                     | بوابة الانتقال                                   |
|---------|----------------------|------------------------------------|--------------------------------------------------|
| 00      | استطلاع الفرع الفعلي | تقرير current-state وخطة ملفات     | لا غموض أو تغييرات متداخلة                       |
| 01      | تأسيس العقود والسجل  | adapters/registry دون تغيير سلوك   | اختبارات OpenAI/Anthropic الحالية تمر            |
| 02      | الاتصالات والأمن     | schema + service + outbound policy | RLS وSSRF وmigration tests تمر                   |
| 03      | OpenAI-compatible    | presets واكتشاف وتوليد عام         | OpenAI + DeepSeek-like + no-models contracts تمر |
| 04      | Anthropic وGemini    | adapters/discovery native          | pagination/error/capability tests تمر            |
| 05      | Embeddings وUX       | فصل الاتصالات وdimension gate وUI  | regression وUI/a11y/i18n تمر                     |
| 06      | التقسية والإطلاق     | backfill/flags/observability/docs  | build كامل وخطة رجوع مجربة                       |

لا تنفذ مرحلتين في migration واحد واسع. لكل مرحلة برومبت مستقل وتقرير وفق القالب.

------------------------------------------------------------------------

## 19. المخاطر والقرارات الحرجة

| الخطر                                | الأثر                            | التخفيف                                                          |
|--------------------------------------|----------------------------------|------------------------------------------------------------------|
| ادعاء توافق OpenAI مع اختلافات فعلية | فشل مزوّدات مخصصة                 | عقد subset واضح، contract tests، manual model، أخطاء مفهومة      |
| SSRF من base URL                     | وصول للبنية الداخلية أو metadata | fixed presets، allowlist، DNS/IP/redirect policy، egress control |
| كشف المفتاح في log أو DTO            | اختراق حساب المزوّد               | server-only، redaction، tests، audit آمن                         |
| خلط أبعاد embeddings                 | نتائج خاطئة أو فشل pgvector      | gate 1536، revision، re-index، لا truncation/padding             |
| اختفاء model من catalog              | تعطيل إعداد عامل                 | catalog إرشادي، حفظ الاختيار، stale/manual                       |
| طلبات اختبار مكلفة                   | تكلفة وإزعاج rate limit          | فصل discovery عن generation test وعدم التكرار عند تغيير سلوكي    |
| migration شامل                       | فقد إعدادات أو توقف              | expand/migrate/contract وfeature flag وrollback                  |
| توسع نطاق المشروع                    | تأخر ومخاطر انحدار               | استبعاد streaming/tools وإضافة كل قدرة بقرار مستقل               |
| PR متداخل في upstream                | تعارض أو تكرار                   | فحص branch/PR قبل التعديل وعدم cherry-pick أعمى                  |

------------------------------------------------------------------------

## 20. معايير القبول النهائية

يُعتبر المشروع مكتمل الإصدار عندما تتحقق كلها:

- [ ] الحسابات الحالية تعمل دون إعادة إدخال مفاتيحها بعد الترحيل الناجح.
- [ ] OpenAI وAnthropic يجتازان اختبارات الانحدار.
- [ ] preset لـ DeepSeek أو mock متوافق يعمل عبر OpenAI-compatible adapter نفسه.
- [ ] Gemini Native يعمل عبر adapter مستقل ومغطى باختبارات العقد.
- [ ] خدمة لا تدعم `/models` يمكن استخدامها باسم model يدوي.
- [ ] refresh فاشل لا يمسح catalog القديم أو model المختار.
- [ ] Chat وEmbeddings قابلان للاختيار من اتصالين مختلفين.
- [ ] vector غير 1536 مرفوض قبل الكتابة إلى قاعدة المعرفة الحالية.
- [ ] تغيير embedding revision لا يخلط فهرسين ويطلب re-index.
- [ ] لا تظهر الأسرار في responses أو logs أو DOM أو snapshots.
- [ ] SSRF tests تغطي private IPv4/IPv6 وredirects وDNS policy.
- [ ] أدوار member/admin والعزل بين الحسابات مثبتة آلياً.
- [ ] errors مطبعة وآمنة ومترجمة ولها request ID.
- [ ] rate limits وtimeouts/size limits مفعلة.
- [ ] كل locale قائم في المشروع محدث.
- [ ] `format:check` و`lint` و`typecheck` و`test` و`build` تمر، أو توجد قيود بيئية موثقة بدقة لا تُخفى.
- [ ] migration/backfill/rollback جُربت على بيانات fixture تشبه القديم.
- [ ] وثائق المشغل والمطور والمستخدم وADRs وتقارير المراحل محدثة.
- [ ] لا يوجد commit أو push أو deploy أو migration إنتاجي تم بلا تفويض صريح.

------------------------------------------------------------------------

## 21. Definition of Done لكل مرحلة

لا تكفي عبارة «الكود يعمل». المرحلة منتهية فقط عند:

1.  تنفيذ النطاق المحدد فقط.
2.  إضافة/تحديث الاختبارات المناسبة.
3.  تشغيل أوامر التحقق الفعلية في المشروع.
4.  مراجعة عدم كشف الأسرار.
5.  تحديث الوثائق والـ ADR عند الانحراف.
6.  كتابة تقرير المرحلة: الملفات، migrations، الاختبارات، المخاطر، rollback، والمتبقي.
7.  عدم وجود TODO أمني مبهم أو fallback صامت.
8.  توضيح أي فشل اختبار قديم أو بيئي مع دليل، من دون وصفه كنجاح.

------------------------------------------------------------------------

## 22. البرومبت التنفيذي الرئيسي لوكيل البرمجة

انسخ النص التالي إلى وكيل البرمجة بعد إتاحة هذه الحزمة داخل المستودع. الأفضل بعده استخدام برومبت كل مرحلة منفردة.

``` text
أنت المسؤول عن تنفيذ مشروع تعدد مزوّدي واتصالات الذكاء الاصطناعي في WACRM. تعامل مع docs/ai-multi-provider/WACRM_MULTI_PROVIDER_MASTER.md بوصفها المواصفات الرئيسية، واقرأ README وخطة الطريق والعقود والأمن والاختبارات والقرارات قبل لمس الكود.

قواعد العمل الإلزامية:

1) ابدأ حصراً بالمرحلة 00 (Reconnaissance). اقرأ تعليمات المستودع المحلية كاملة، ومنها AGENTS.md/CLAUDE.md وأي تعليمات متداخلة. افحص git status والفرع والالتزام، ولا تكتب فوق تغييرات المستخدم. اقرأ وثائق Next.js المحلية التي تلزمك بها تعليمات المشروع قبل تعديل كود Next.js.

2) لا تفترض أن لقطة المستودع المذكورة في الوثائق تطابق الفرع الحالي. ابنِ خريطة فعلية لمسارات AI وconfig وdatabase وRLS وUI وi18n والاختبارات. افحص وجود تغييرات أو PRs متداخلة في تعدد المزوّدات، ولا تدمج أو تنسخ شيئاً بصورة عمياء.

3) لا تبدأ التنفيذ قبل تسليم تقرير استكشاف يوضح: الوضع الحالي، الفجوات، الملفات المقترحة، رقم migration التالي، المخاطر، وخطة تحقق. إن وجدت تغييرات محلية متداخلة أو قراراً قد يسبب فقد بيانات، توقف واطلب قراراً.

4) نفّذ مرحلة واحدة فقط في كل مرة، مستخدماً prompt المرحلة المقابل. حافظ على حجم diff قابل للمراجعة. لا تخلط refactor واسعاً أو features غير مطلوبة مثل streaming/tools/agents.

5) افصل ProviderProtocol عن ProviderPreset وعن account Connection. DeepSeek/OpenRouter/9Router والخدمات القياسية تستخدم OpenAI-compatible adapter بدلاً من نسخ adapter لكل اسم. Gemini يستخدم Native adapter في النطاق الحالي. اكتشاف النماذج قدرة اختيارية، والإدخال اليدوي يبقى دائماً.

6) لا تجعل العميل يتصل بالمزوّد مباشرة، ولا ترجع أو تسجل المفتاح أو ciphertext أو Authorization header أو provider response الخام أو prompts. استخدم التشفير الحالي بصورة متوافقة، وطبّق redaction واختبارات تمنع التسرب.

7) أي base URL مخصص يمر عبر سياسة outbound موحدة تمنع SSRF وDNS rebinding وprivate/loopback/link-local/metadata/IPv4-mapped IPv6 والredirect غير المفحوص. presets الثابتة لا يقبل عنوانها override من payload. دعم 9Router المحلي لا يفتح localhost للجميع؛ يحتاج deployment-level opt-in/allowlist صريحاً.

8) افصل فحص الاتصال/جلب النماذج عن اختبار model بالتوليد. الكتالوج advisory/cache فقط: لا تمسح model المحفوظ عند فشل أو اختفاء، لا تعتبر unknown unsupported، واترك manual entry. ضع timeouts وlimits للصفحات والصفوف والبايتات وrate/concurrency.

9) لا توسع Embeddings بلا معالجة قيد vector(1536) الموجود. في الإصدار الحالي تحقق فعلياً أن الناتج 1536، واحفظ model/dimensions/revision، ولا تقص أو تملأ المتجهات. أي تغيير يحتاج re-index واضحاً ولا يخلط revisions. حافظ على lexical fallback.

10) نفّذ الترحيل بنمط expand/migrate/switch/contract. لا تحذف الأعمدة القديمة في إصدار التحويل. اجعل backfill idempotent ومغطى باختبارات، واستخدم feature flag وخطة rollback. لا تشغل migration إنتاجياً ولا deploy ولا push ولا commit من دون تفويض صريح.

11) طبّع الأخطاء إلى codes آمنة مع request ID وretryable، وسجل تفاصيل منقحة فقط. لا تعِد generation تلقائياً بما قد يكرر التكلفة. اسمح بإعادة محدودة فقط لطلبات idempotent وباحترام Retry-After.

12) بعد كل مرحلة شغّل الأوامر المتاحة فعلياً، والمتوقع مبدئياً: format:check، lint، typecheck، test، build. لا تدّع نجاح أمر لم تشغله. حدّث كل locales القائمة ولا تضف نصوص UI ثابتة.

13) اكتب تقرير المرحلة وفق templates/PHASE_REPORT_TEMPLATE.md، ويشمل الملخص، القرارات، الملفات، schema، security review، الاختبارات ونتائج الأوامر، المخاطر، rollback، والأسئلة المفتوحة. إذا انحرفت مادياً عن المواصفات، أنشئ ADR قبل الكود أو معه يشرح البدائل والسبب.

الآن نفّذ المرحلة 00 فقط وفق prompts/PHASE_00_RECONNAISSANCE.md، وأعد التقرير المطلوب. لا تعدل كود المنتج في هذه المرحلة.
```

------------------------------------------------------------------------

## 23. إرشادات إضافة مزوّد مستقبلاً

### إذا كان متوافقاً فعلاً مع بروتوكول موجود

1.  أضف preset.
2.  وثّق API root والمصادقة والسياسة.
3.  أضف fixtures/contract tests الخاصة باختلافاته.
4.  لا تنشئ adapter جديداً إلا إذا خرج عن subset المدعوم.

### إذا كان بروتوكولاً جديداً

1.  اكتب ADR.
2.  عرّف adapter صغيراً يطبق القدرات الفعلية فقط.
3.  أضف normalization/error mapping/contract tests.
4.  لا تغيّر مستهلكي AI ما دام العقد الداخلي كافياً.

### قائمة مراجعة

- هل المصادقة server-controlled؟
- هل list models موجودة فعلاً وما pagination؟
- هل model IDs تحتاج تطبيعاً؟
- هل usage mapping واضح؟
- هل system prompt منفصل أم رسالة؟
- هل الأدوار المتتابعة مسموحة؟
- هل embeddings موجودة، وما البُعد؟
- هل endpoint ثابت أم custom؟
- ما حدود الحجم والمهلة وإعادة المحاولة؟
- ما بيانات الخطأ التي يجب حجبها؟

------------------------------------------------------------------------

## 24. المراجع الفنية الأساسية

يجب إعادة التحقق من المراجع عند التنفيذ لأن APIs تتغير:

- WACRM: <https://github.com/ArnasDon/wacrm>
- OpenAI Models API: <https://developers.openai.com/api/reference/resources/models/methods/list/>
- Anthropic List Models: <https://platform.claude.com/docs/en/api/models/list>
- Gemini Models API: <https://ai.google.dev/api/models>
- Gemini OpenAI compatibility: <https://ai.google.dev/gemini-api/docs/openai>
- Gemini partner integration guidance: <https://ai.google.dev/gemini-api/docs/partner-integration>
- DeepSeek API quick start: <https://api-docs.deepseek.com/>
- DeepSeek List Models: <https://api-docs.deepseek.com/api/list-models/>
- 9Router repository: <https://github.com/decolua/9router>
- 9Router architecture: <https://github.com/decolua/9router/blob/master/docs/ARCHITECTURE.md>

------------------------------------------------------------------------

## 25. ملاحظة ختامية للمالك والمراجع

أهم قرارين في هذه المبادرة ليسا «إضافة Gemini» أو «إضافة dropdown للنماذج»، بل:

1.  جعل الاتصال كياناً مستقلاً والمزوّد بروتوكولاً قابلاً للتبديل، كي لا يتكرر الدين التقني مع كل خدمة جديدة.
2.  اعتبار عنوان API المخصص وحدود Embeddings مسائل أمن وسلامة بيانات من الدرجة الأولى.

إذا حافظ التنفيذ على هذين القرارين، يمكن إضافة مزوّدات جديدة بتغييرات صغيرة ومدروسة. وإذا تم تجاوزهما، سيبدو الإصدار الأول أسرع لكنه سيعيد المشكلة نفسها بصورة أكبر وأكثر خطورة.

# العمارة المستهدفة

**الحالة:** Normative  
**يرتبط بـ:** `WACRM_MULTI_PROVIDER_MASTER.md`  
**الغرض:** تحديد حدود الوحدات ومسؤولياتها وتدفق البيانات، من دون فرض أسماء ملفات على فرع قد يختلف عن اللقطة المرجعية.

## 1. السياق

يستهلك WACRM الذكاء الاصطناعي في أكثر من مسار: إنشاء مسودة، الرد الآلي، اختبار الإعداد، وتضمين نصوص قاعدة المعرفة والبحث الدلالي. التصميم المستهدف يُبقي هذه المستهلكات مستقلة عن تفاصيل أي مزوّد.

المستهلك يطلب قدرة مثل `generate` أو `embed`. خدمة الذكاء الاصطناعي تحمّل اتصال الحساب الآمن، ثم يحل Registry المهايئ المناسب. المهايئ يعرف بروتوكول HTTP فقط، ولا يعرف Supabase أو session أو أدوار المستخدم.

## 2. حدود المكونات

``` mermaid
flowchart TD
  C["Server consumers"] --> AIS["AI service"]
  R["Settings routes"] --> CMS["Connection management"]
  AIS --> LOAD["Secure connection loader"]
  CMS --> LOAD
  CMS --> OUT["Outbound policy client"]
  AIS --> OUT
  LOAD --> DB[("Database + encrypted secrets")]
  AIS --> REG["Adapter registry"]
  CMS --> REG
  REG --> OUT
```

### 2.1 Server consumers

أمثلة: draft route، auto-reply engine، knowledge ingestion، knowledge retrieval، config test. مسؤوليتها بناء intent وسياق المجال، لا headers أو URLs.

### 2.2 AI service

مسؤول عن:

- التحقق من وجود config صالح.
- تحميل الاتصال المناسب للقدرة المطلوبة.
- تمرير الطلب إلى adapter.
- تطبيق handoff parsing وسجل usage كما في السلوك الحالي.
- اختيار fallback المشروع، مثل lexical retrieval عند تعذر semantic retrieval.

ليس مسؤولاً عن:

- قبول base URL من العميل.
- بناء قائمة presets.
- تشفير/فك سر عند كل طبقة عشوائياً.

### 2.3 Connection management service

مسؤول عن lifecycle الاتصال:

- create/update/disable/delete.
- normalize وvalidate API root.
- encrypt/decrypt في نطاق خادم محدود.
- حساب fingerprint لا يكشف السر.
- discover models وتخزين catalog المطبّع.
- test selected model.
- invalidation عند تغير root/key/protocol.
- فحص المراجع قبل الحذف.

### 2.4 Secure connection loader

واجهة واحدة تعيد `RuntimeConnection` للخادم فقط. يجب ألا يخرج الكائن عن الذاكرة اللازمة للطلب، وألا يُمرر إلى logger أو client serializer. يعيد خطأً آمناً عند فشل فك التشفير، ولا يطبع ciphertext.

### 2.5 Outbound policy client

غلاف مركزي فوق HTTP client/fetch. لا يجوز للمهايئات استدعاء URL مخصص مباشرة من دون المرور به. يتولى:

- canonicalization.
- scheme/host/port validation.
- DNS resolution وIP classification.
- redirect policy.
- time/size limits.
- headers sanitation.
- request ID وقياسات آمنة.

يمكن السماح لعناوين preset الثابتة بمسار fast path، لكن تظل timeouts وsize limits وredaction مطبقة.

### 2.6 Adapter registry

سجل immutable يُنشأ على الخادم ويربط `ProviderProtocol` بمهايئ واحد. لا يقرأ قيمته من اسم class مرسل من العميل، ولا يستخدم dynamic import لمسار يختاره المستخدم.

``` ts
const adapters = new Map<ProviderProtocol, ProviderAdapter>([
  ['openai_compatible', openAiCompatibleAdapter],
  ['anthropic_compatible', anthropicAdapter],
  ['gemini_native', geminiAdapter],
])
```

### 2.7 Preset registry

قائمة declarative لأسماء الخدمات المعروفة. مثال مفاهيمي لا يُنسخ قبل التحقق من URLs الرسمية:

| preset                      | protocol             | API root | mode              |
|-----------------------------|----------------------|----------|-------------------|
| OpenAI                      | openai_compatible    | fixed    | public            |
| DeepSeek                    | openai_compatible    | fixed    | public            |
| OpenRouter                  | openai_compatible    | fixed    | public            |
| Custom OpenAI-compatible    | openai_compatible    | custom   | deployment policy |
| Anthropic                   | anthropic_compatible | fixed    | public            |
| Custom Anthropic-compatible | anthropic_compatible | custom   | deployment policy |
| Gemini                      | gemini_native        | fixed    | public            |
| 9Router/private gateway     | openai_compatible    | custom   | deployment opt-in |

يجب مراجعة العنوان الرسمي وقت التنفيذ. لا تحفظ preset key أو header value سرياً في القائمة.

## 3. فصل Connection عن Config

### Connection

يمثل «كيف أصل إلى API». قابل لإعادة الاستخدام بواسطة Chat أو Embeddings، ومملوك لحساب.

### AI config

يمثل «كيف يتصرف المساعد»: system prompt، active، auto-reply، handoff، النموذج المختار، وروابط الاتصالات.

الفصل يمنع تكرار السر عند استخدام الاتصال نفسه، ويسمح باتصال Chat من Anthropic واتصال Embeddings من OpenAI/Gemini، ويجعل تبديل المزوّد لا يغير سلوك المساعد.

## 4. نموذج القدرات

القيمة الثنائية غير كافية؛ كثير من `/models` لا يعلن الغرض. استخدم:

``` ts
type CapabilityState = 'supported' | 'unsupported' | 'unknown'
```

قواعد قرار UI/Service:

| الحالة      | العرض                     | السماح بالاختيار        |
|-------------|---------------------------|-------------------------|
| supported   | يظهر أولاً وبشارة واضحة    | نعم                     |
| unknown     | يظهر بعد المدعوم مع تنبيه | نعم، مع اختبار فعلي     |
| unsupported | مخفي افتراضياً للقدرة      | لا، إلا وضع تشخيص إداري |

لا تحول name heuristic إلى `unsupported`. يمكن لـ heuristic اقتراح فئة أو ترتيب فقط.

## 5. تدفق إنشاء اتصال والتحقق

``` mermaid
sequenceDiagram
  participant U as Admin UI
  participant A as Server API
  participant C as Connection service
  participant P as Provider
  participant D as Database
  U->>A: preset + name + key + optional root
  A->>C: validated intent
  C->>C: resolve preset + outbound policy
  C->>P: list models or auth probe
  P-->>C: bounded response
  C->>C: normalize + redact
  C->>D: encrypt key + save metadata/catalog
  D-->>A: safe connection DTO
  A-->>U: status + model catalog
```

### قواعد ذرية

- إذا فشل التحقق قبل الإنشاء، لا يُنشأ اتصال بنصف بيانات إلا إذا اختار UX صراحة «Save unverified» ضمن سياسة المنتج.
- التوصية: السماح بحفظ `unverified` للـ custom APIs التي لا تدعم list models، ثم اشتراط test model قبل تفعيلها.
- عند تعديل اتصال قائم وفشل المفتاح الجديد، يبقى المفتاح القديم صالحاً ولا يُستبدل.
- تحديث السر والـ fingerprint وinvalidation والكتالوج يتم في معاملة منطقية واحدة.

## 6. تدفق اكتشاف النماذج

1.  يتحقق route من admin role وrate limit.
2.  يحمل connection ويحسب fingerprint الحالي.
3.  يفحص policy قبل DNS/HTTP.
4.  ينادي `adapter.listModels` إن وجدت.
5.  يجمع الصفحات ضمن الحدود.
6.  يطبع العناصر، ويزيل التكرار حسب ID canonical.
7.  يحد الحقول والحجم ويرتب بثبات.
8.  يتحقق أن fingerprint لم يتغير أثناء الطلب.
9.  يحفظ الكتالوج و`fetched_at` ويزيل خطأه السابق.
10. يعيد DTO آمناً.

عند الفشل:

- يسجل code آمن وrequest ID.
- لا يمسح آخر catalog ناجح.
- يعيد `stale=true` إن وجد cache.
- يبين أن manual entry متاح.

## 7. تدفق التوليد

``` mermaid
sequenceDiagram
  participant S as Draft/Auto-reply
  participant A as AI service
  participant L as Connection loader
  participant R as Registry
  participant P as Provider
  S->>A: config + messages
  A->>L: chat_connection_id
  L-->>A: RuntimeConnection
  A->>R: resolve(protocol)
  R-->>A: adapter
  A->>P: normalized generate request
  P-->>A: text + normalized usage
  A->>A: handoff parsing
  A-->>S: GenerateResult
```

قواعد:

- لا يدخل model catalog في المسار الساخن؛ النموذج المحفوظ يُستخدم مباشرة.
- لا يجري refresh catalog ضمن generation.
- timeout قابل للضبط من الخادم ضمن حدود، لا من العميل.
- لا retry تلقائياً للتوليد افتراضياً.
- الأخطاء تحافظ على code متسق للمستهلك الحالي.

## 8. تدفق Embeddings وإصدارات الفهرس

### 8.1 إنشاء revision

هوية revision المقترحة مشتقة من:

``` text
protocol + preset/connection identity + model + dimensions + provider options version
```

لا تتضمن السر. تحفظ كمعرّف صريح أو hash غير حساس.

### 8.2 تغيير الإعداد

``` mermaid
stateDiagram-v2
  [*] --> Current
  Current --> PendingReindex: embedding config changed
  PendingReindex --> Building: reindex started
  Building --> Ready: all chunks validated
  Building --> Failed: bounded failure
  Failed --> Building: retry
  Ready --> Current: atomic activation
```

- يستمر البحث على revision السابقة حتى جاهزية الجديدة، أو يستخدم lexical fallback إن لم توجد سابقة.
- لا تتحول القراءة إلى revision جديدة قبل اكتمال chunks المطلوبة والتحقق من الأبعاد.
- cleanup للقديمة خطوة مستقلة بعد فترة رجوع.

إن كان نطاق الإصدار لا يسمح ببناء نظام revisions كامل، يجب اختيار بديل محافظ: تعطيل semantic مؤقتاً، إعادة فهرسة كاملة، ثم التفعيل. لا يجوز مزج المتجهات.

## 9. استراتيجية أخطاء الطبقات

### AdapterError

يحمل معلومات داخلية منقحة: operation، provider status، retry-after، cause category. لا يخرج مباشرة إلى العميل.

### AiError/ApplicationError

يحمل code العام، status مناسب، retryable، request ID، ومفتاح ترجمة. يحظر تضمين body الخام في message.

### UI

يعرض رسالة عملية مثل «تعذر الوصول إلى الخدمة. تحقق من العنوان أو حاول لاحقاً» مع request ID عند الحاجة للدعم.

## 10. نقاط الامتداد المسموحة

- preset جديد لبروتوكول موجود.
- adapter جديد لبروتوكول جديد.
- normalizer خاص بالـ catalog ضمن adapter.
- auth strategy جديدة مسجلة على الخادم، بقرار أمني.
- provider options typed ومحدودة؛ لا `Record<string, any>` يمر مباشرة إلى body.

## 11. Anti-patterns ممنوعة

- توسيع `switch (providerName)` مع كل مزوّد.
- تخزين provider label باعتباره protocol.
- السماح للعميل بإرسال headers أو method أو full endpoint.
- استخدام `fetch(body.baseUrl + '/v1/...')` مباشرة.
- جلب النماذج في React effect مع المفتاح.
- اعتبار فشل `/models` دليلاً على فشل Chat.
- حذف model المحفوظ إذا لم يظهر في القائمة.
- اكتشاف القدرة بالاسم كحكم نهائي.
- تمرير response error للمزوّد إلى المستخدم كما هو.
- retry للتوليد من دون idempotency.
- تخزين vectors مختلفة الأبعاد في الفهرس الحالي.

## 12. معايير قبول العمارة

- مستهلكا draft وauto-reply لا يستوردان adapters مباشرة.
- لا توجد معرفة بـ DeepSeek أو Gemini في منطق domain العام، عدا preset/registry/config.
- adapter tests لا تحتاج Supabase.
- connection service tests لا تحتاج مزوّداً حقيقياً.
- outbound policy لها اختبارات مستقلة وقابلة لحقن resolver/transport.
- إزالة preset لا تكسر اتصالاً محفوظاً بصمت؛ هناك migration/deprecation path.
- يمكن شرح إضافة مزوّد OpenAI-compatible جديد بأنها preset + tests فقط.

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

``` ts
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

``` ts
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

``` ts
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

``` sql
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

``` sql
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

``` json
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

``` json
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

``` json
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

``` json
{ "force_refresh": true }
```

استجابة نجاح:

``` json
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

``` json
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

``` json
{
  "capability": "chat",
  "model": "provider-model-id",
  "dimensions": null
}
```

أو للـ Embeddings:

``` json
{
  "capability": "embeddings",
  "model": "provider-embedding-model",
  "dimensions": 1536
}
```

استجابة:

``` json
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

``` json
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

``` ts
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

| code                            |                                           HTTP |
|---------------------------------|-----------------------------------------------:|
| invalid request/field           |                                            400 |
| invalid credentials             | 400 أو 401 داخلياً، مع مراعاة convention الحالي |
| caller unauthorized             |                                            401 |
| caller lacks role               |                                            403 |
| connection not found in account |                                            404 |
| config conflict/stale write     |                                            409 |
| provider rate limit             |            429 أو 502 مع code؛ اختر عقداً ثابتاً |
| outbound blocked                |                                            400 |
| provider unavailable/malformed  |                                            502 |
| provider timeout                |                                            504 |

تمييز caller auth عن provider auth مهم؛ لا تجعل 401 من المزوّد يوحي بأن session المستخدم انتهت.

## 14. Optimistic concurrency

ينصح باستخدام `updated_at` أو version في PATCH لمنع حفظ tab قديم فوق تعديل جديد:

``` json
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

# مصفوفة توافق المزوّدات والبروتوكولات

**تاريخ التحقق المرجعي:** 2026-09-03  
**الحالة:** مرجع تصميم؛ يجب إعادة التحقق من الوثائق الرسمية وقت التنفيذ  
**قاعدة:** URLs وأسماء النماذج تتغير. تحفظ presets الجذور الرسمية في الخادم، ولا تحول هذه الصفحة إلى allowlist لأسماء النماذج.

## 1. المصفوفة المختصرة

| المزوّد/النمط                    | Protocol داخل WACRM         | API root المرجعي                                    | Chat                          | Models                           | Embeddings                          | ملاحظة القدرة                                     |
|---------------------------------|-----------------------------|-----------------------------------------------------|-------------------------------|----------------------------------|-------------------------------------|---------------------------------------------------|
| OpenAI                          | `openai_compatible`         | `https://api.openai.com/v1/`                        | `chat/completions`            | `models`                         | `embeddings`                        | قائمة models أساسية ولا تكفي وحدها لتصنيف القدرة  |
| DeepSeek                        | `openai_compatible`         | قيمة preset تتحقق من الوثائق                        | OpenAI-compatible             | OpenAI-compatible                | لا يُفترض قبل التحقق                 | لا hard-code أسماء النماذج                        |
| OpenRouter أو بوابة عامة مماثلة | `openai_compatible`         | preset موثق إن دخل النطاق                           | غالباً OpenAI-compatible       | حسب الخدمة                       | حسب الخدمة                          | الاختلافات تختبر بعقد خاص ولا تغير المستهلك       |
| 9Router/self-hosted gateway     | `openai_compatible`         | غالباً deployment-local `/v1/`                       | OpenAI-compatible             | `/v1/models` وفق المشروع المرجعي | حسب backend                         | يحتاج deployment opt-in/allowlist؛ محجوب افتراضياً |
| Custom OpenAI-compatible        | `openai_compatible`         | User intent بعد server policy                       | subset الموثق                 | اختياري                          | اختياري                             | manual model إلزامي كمسار بديل                    |
| Anthropic                       | `anthropic_compatible`      | `https://api.anthropic.com/v1/`                     | `messages`                    | `models`                         | لا endpoint أصلي مفترض              | model pagination وheaders خاصة                    |
| Custom Anthropic-compatible     | `anthropic_compatible`      | بعد server policy                                   | Anthropic subset              | اختياري                          | لا يُفترض                            | لا تفترض أحدث capabilities fields                 |
| Gemini Native                   | `gemini_native`             | `https://generativelanguage.googleapis.com/v1beta/` | `models/{id}:generateContent` | `models`                         | `models/{id}:embedContent` حيث يدعم | `supportedGenerationMethods` مفيدة للتصنيف        |
| Gemini عبر OpenAI compatibility | `openai_compatible` اختياري | `.../v1beta/openai/`                                | `chat/completions`            | `models`                         | وفق الواجهة الرسمية                 | ليس المسار الأساسي لهذا المشروع؛ Native مفضل      |

## 2. المصادقة

| Protocol             | الاستراتيجية                                                    | مصدر القيمة                | ممنوع                             |
|----------------------|-----------------------------------------------------------------|----------------------------|-----------------------------------|
| OpenAI-compatible    | `Authorization: Bearer ...` ضمن subset الأساسي                  | adapter server-side        | header name/value من العميل       |
| Anthropic-compatible | `x-api-key` وversion headers                                    | adapter/preset server-side | version عشوائية من المستخدم       |
| Gemini Native        | header الرسمي الموصى به مثل `x-goog-api-key` حيث يقبله endpoint | adapter server-side        | query URL مسجل أو مفتاح في العميل |

إن تطلب مزوّد متوافق header إضافياً، لا تسمح `custom headers` عامة. أضف auth strategy typed ومراجعة أمنية أو أجّل ذلك المزوّد.

## 3. اكتشاف النماذج

### 3.1 OpenAI-compatible

الشكل الأدنى المقبول:

``` json
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

| المصدر            | طريقة التحقق                                              | قرار الإصدار الحالي             |
|-------------------|-----------------------------------------------------------|---------------------------------|
| OpenAI-compatible | طلب `embeddings` صغير، count/order/finiteness/dimension   | يقبل فقط إذا الناتج 1536        |
| Gemini Native     | `embedContent`/batch الرسمي وخيار dimension إن كان مدعوماً | يقبل فقط إذا الناتج الفعلي 1536 |
| Anthropic         | لا تفترض endpoint أصلياً                                   | اختر اتصال Embeddings آخر       |
| Gateway مخصص      | لا تعتمد على اسم النموذج أو ادعاء التوافق                 | probe فعلي ثم 1536 gate         |

لا يثبت `GET /models` بُعد المتجه. القياس الفعلي شرط قبل تفعيل الفهرس.

## 6. درجات التوافق

يمكن أن يسجل الاختبار الداخلي نتيجة دون عرض تعقيد زائد للمستخدم:

| الدرجة                | المعنى                                |
|-----------------------|---------------------------------------|
| `verified_protocol`   | اجتاز fixture/contract الرسمي للمشروع |
| `verified_connection` | نجح اتصال ومصادقة الحساب              |
| `verified_model`      | نجح طلب فعلي للنموذج المختار          |
| `catalog_only`        | ظهر في القائمة ولم يختبر              |
| `manual_unverified`   | أدخله المستخدم ولم يختبر              |

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

1.  ما protocol والـ subset المثبت؟
2.  ما API root الرسمي وهل هو ثابت؟
3.  ما auth strategy؟
4.  هل models endpoint موجود؟ وما pagination/limits؟
5.  هل metadata تصف القدرات أم تبقى unknown؟
6.  هل chat fixture ينجح بالعقد الحالي؟
7.  هل provider error ينقح بأمان؟
8.  هل عنوانه عام أم يحتاج deployment opt-in؟
9.  هل Embeddings موجودة وما dimension الفعلية؟
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

# سجل القرارات المعمارية

هذا الملف يجمع القرارات الأساسية التي لا ينبغي تغييرها أثناء التنفيذ من دون ADR جديد. الحالة `Accepted` تعني أنها افتراض التصميم الحالي، لا أنها نُفذت في الكود.

## ADR-001: فصل Protocol وPreset وConnection

**الحالة:** Accepted  
**السياق:** ربط المنطق باسم العلامة التجارية يؤدي إلى `switch` متزايد وتكرار مهايئات متطابقة.  
**القرار:** protocol يحدد عقد API، preset يحدد UX والقيم الثابتة، connection يحدد إعداد حساب وسره.  
**النتيجة:** DeepSeek وOpenRouter و9Router يستخدمون OpenAI-compatible adapter ما داموا ضمن الـ subset المدعوم.  
**البديل المرفوض:** `AiProvider` يحتوي اسماً لكل شركة ومهايئاً كاملاً لكل اسم؛ سهل أول مرة لكنه يضاعف الصيانة والاختبارات.

## ADR-002: Connection ككيان مستقل

**الحالة:** Accepted  
**السياق:** `ai_configs` الحالي يجمع سلوك المساعد والسر واختيار النموذج.  
**القرار:** إضافة `ai_provider_connections` وربط Chat وEmbeddings به، مع بقاء `ai_configs` لسلوك المساعد.  
**النتيجة:** يمكن أكثر من اتصال وفصل Chat/Embeddings وتدوير المفتاح بصورة مستقلة.  
**المقابل:** migration وUI أكبر من مجرد إضافة أعمدة provider/base_url. هذا مقبول لأنه يزيل أصل المشكلة.

## ADR-003: Gemini Native ضمن النطاق الأساسي

**الحالة:** Accepted  
**السياق:** Gemini يوفر واجهة متوافقة مع OpenAI، لكنه يملك API Native وmetadata وقدرات أصلية أوضح.  
**القرار:** بناء Gemini Native adapter، ويمكن لاحقاً تقديم preset توافق OpenAI كخيار ثانوي إذا ثبتت حاجة.  
**النتيجة:** تحكم أدق في model discovery وsupported generation methods وembeddings.  
**البديل:** استعمال OpenAI compatibility فقط؛ أقل كوداً لكنه يربط حدود Gemini بعقد وسيط وقد يخفي ميزات/metadata.

## ADR-004: Model discovery اختياري وإرشادي

**الحالة:** Accepted  
**السياق:** بعض الخدمات لا تطبق `/models` أو لا تعرض capabilities.  
**القرار:** `listModels?` اختيارية، manual model دائم، والكتالوج cache advisory.  
**النتيجة:** فشل الاكتشاف لا يمنع خدمة تعمل بالتوليد.  
**البديل المرفوض:** dropdown مغلق لا يقبل إلا القائمة؛ يكسر custom gateways والنماذج الجديدة/المخفية.

## ADR-005: Capability ثلاثية الحالة

**الحالة:** Accepted  
**السياق:** غياب metadata ليس دليلاً على عدم الدعم.  
**القرار:** `supported | unsupported | unknown`.  
**النتيجة:** لا تُحجب النماذج المجهولة، ويصبح الاختبار الفعلي طريق الإثبات.  
**البديل المرفوض:** boolean افتراضي false؛ يخلق false negatives.

## ADR-006: فصل اكتشاف الاتصال عن اختبار النموذج

**الحالة:** Accepted  
**السياق:** list models قد يثبت المفتاح لكنه لا يثبت chat، والتوليد التجريبي قد يكلف.  
**القرار:** عمليتان وحالتا تحقق منفصلتان.  
**النتيجة:** UX أدق وطلبات مدفوعة أقل.  
**البديل:** طلب ping في كل حفظ؛ يستهلك الحصة ويزيد زمن الحفظ بلا داعٍ عند تعديل toggle فقط.

## ADR-007: سياسة SSRF على مستوى النشر

**الحالة:** Accepted  
**السياق:** custom base URL و9Router المحلي يتعارضان مع أمان SaaS الافتراضي.  
**القرار:** public HTTPS آمن افتراضياً؛ العناوين الخاصة محجوبة، وprivate gateways تحتاج deployment-level opt-in/allowlist لا يملكه مستأجر عادي.  
**النتيجة:** self-hosted يمكنه تمكين وجهته المعروفة، بينما لا يصبح WACRM proxy إلى الشبكة الداخلية.  
**البديل المرفوض:** checkbox «Allow insecure/local» لكل Admin؛ يسمح بتجاوز الحدود الأمنية.

## ADR-008: الحفاظ على 1536 بُعداً في الإصدار الحالي

**الحالة:** Accepted  
**السياق:** مخطط pgvector المرجعي وفهرسه يستخدمان `vector(1536)`.  
**القرار:** قبول embedding model فقط بعد إثبات خروج 1536، مع revision وre-index عند التغيير.  
**النتيجة:** دعم مزوّدات متعددة ضمن قيد سلامة واضح، وتأجيل multi-dimension لمشروع منفصل.  
**البدائل المرفوضة:** truncate/pad محلياً، أو خلط الأطوال، أو تعديل العمود بلا إعادة فهرسة؛ كلها تفسد معنى التشابه أو الفهرس.

## ADR-009: Expand/Migrate/Contract

**الحالة:** Accepted  
**السياق:** تبديل schema والكود دفعة واحدة يهدد مفاتيح وإعدادات قائمة.  
**القرار:** إضافة ثم backfill ثم تحويل تحت flag، وحذف القديم في إصدار لاحق فقط.  
**النتيجة:** rollback فعلي ومقارنة مسارين.  
**المقابل:** فترة تعايش وازدواج مؤقت موثق.

## ADR-010: لا Streaming ولا Tools في هذا النطاق

**الحالة:** Accepted  
**السياق:** abstraction قد يغري ببناء قدرات مستقبلية قبل حاجتها، بينما المستهلك المرجعي non-streaming.  
**القرار:** العقد يضم القدرات المستهلكة فقط: generate، list models optional، embed optional.  
**النتيجة:** diff أصغر واختبارات أوضح.  
**إعادة النظر:** عند وجود قصة منتج ومستهلك UI حقيقي للـ streaming أو tools.

## ADR-011: JSONB محدود للكتالوج أولاً

**الحالة:** Accepted مبدئياً  
**السياق:** الكتالوج cache لكل اتصال ويُستبدل كوحدة.  
**القرار:** حفظ normalized bounded JSONB مع fetched_at، لا جدول model history.  
**النتيجة:** schema أبسط.  
**إعادة النظر:** قوائم ضخمة، استعلام عالمي، تاريخ، أو مشاركة catalog بين حسابات.

## ADR-012: عدم إعادة توليد الرد تلقائياً

**الحالة:** Accepted  
**السياق:** retry بعد timeout قد يعني أن المزوّد عالج الطلب بالفعل، ما يكرر التكلفة/الرد.  
**القرار:** generation بلا retry افتراضي؛ retries bounded للعمليات idempotent فقط.  
**النتيجة:** اتساق وتكلفة أوضح.  
**إعادة النظر:** إذا دعم المزوّد idempotency key موثوقاً واستوعبه العقد.

## ADR-013: رسائل أخطاء عامة وتفاصيل منقحة داخلياً

**الحالة:** Accepted  
**السياق:** provider body قد يحتوي endpoint أو account details أو echo لمدخلات.  
**القرار:** public error code/message/request ID، والتفاصيل بعد redaction في server logs فقط.  
**النتيجة:** تشخيص مع حماية البيانات.  
**البديل المرفوض:** تمرير `response.text()` مباشرة للـ UI.

## ADR-014: لا headers مخصصة حرة في الإصدار الأول

**الحالة:** Accepted  
**السياق:** custom headers تزيد التوافق لكنها تسمح بتجاوز auth/redaction وإدخال قيم حساسة غير مشفرة.  
**القرار:** auth strategies وheaders يحددها adapter/preset على الخادم.  
**النتيجة:** subset أقل لكنه قابل للحماية.  
**إعادة النظر:** حاجة مثبتة، schema مشفر typed، allowlist أسماء، وsecurity review.

## طريقة إضافة قرار جديد

استخدم `templates/ADR_TEMPLATE.md`، وأضف رابطاً هنا. لا يكفي تعليق كود لتغيير قرار يمس البيانات أو الأمن أو التوافق الخلفي.

# الأمن والاعتمادية والتشغيل

**الحالة:** Normative  
**النطاق:** مفاتيح BYOK، الاتصالات الصادرة، API routes، قاعدة البيانات، السجلات، ضبط التكلفة، وإدارة الحوادث.

## 1. نموذج التهديد

### الأصول المطلوب حمايتها

- مفاتيح API التي يملكها العميل.
- محتوى المحادثات وsystem prompts وقاعدة المعرفة.
- حدود حساب WACRM وبيانات حسابات أخرى.
- الشبكة الداخلية وmetadata services وواجهات الإدارة في بيئة الاستضافة.
- حصة/رصيد API للمستخدم.
- سلامة فهرس embeddings ونتائج الاسترجاع.

### جهات محتملة

- عضو عادي يحاول استدعاء endpoint إداري.
- Admin لحساب يحاول الوصول إلى حساب آخر أو الشبكة الداخلية.
- مزوّد/بوابة مخصصة خبيثة تعيد redirects أو response ضخم أو JSON مشوهاً.
- مهاجم يملك مفتاحاً مسروقاً ويحاول معرفة صلاحياته من خلال WACRM.
- خطأ برمجي يسجل السر أو يمرر provider error الخام.
- إساءة استخدام شرعية ظاهرياً تسبب تكلفة أو rate exhaustion.

### حدود الثقة

``` mermaid
flowchart TD
  B["Browser: untrusted input"] --> S["WACRM server"]
  S --> D[("Account-scoped database")]
  S --> N["Outbound network boundary"]
  N --> P["Provider or custom gateway"]
```

- كل ما يأتي من المتصفح غير موثوق، حتى لو أخفاه UI.
- ciphertext في قاعدة البيانات حساس، وليس «آمناً للنشر» لمجرد أنه مشفر.
- response المزوّد غير موثوق ويخضع للحجم والتحليل والتنقيح.

## 2. التحكم في الوصول

| العملية                                | الحد الأدنى المقترح |
|----------------------------------------|---------------------|
| قراءة حالة config واتصال آمن           | member داخل الحساب  |
| إنشاء/تعديل/استبدال سر/اختبار/حذف      | admin داخل الحساب   |
| تفعيل private endpoint على مستوى النشر | مشغّل deployment فقط |
| تشغيل backfill/migration               | إجراء تشغيلي مخول   |
| قراءة logs الداخلية                    | دور تشغيل مقيد      |

قواعد:

- جميع المسارات تستخرج `accountId` من session/server context، لا من body.
- `connectionId` يبحث عنه مع `account_id` في query نفسه.
- عدم العثور على اتصال من حساب آخر يعامل كـ 404 لتقليل كشف الوجود.
- لا يعتمد الأمان على UI disabled state.
- mutation routes لها CSRF/Origin protection وفق نمط Next.js والمشروع.
- rate limit لا يستبدل authorization.

## 3. إدارة الأسرار

### 3.1 دورة السر

``` mermaid
stateDiagram-v2
  [*] --> Entered: Admin submits
  Entered --> Validated: Server validates format
  Validated --> Encrypted: Encrypt before persistence
  Encrypted --> InUse: Decrypt server-side per request
  InUse --> Rotated: Replace explicitly
  Rotated --> Encrypted
  Encrypted --> Deleted: Connection removal
```

### 3.2 متطلبات ملزمة

- الحقل input يستخدم HTTPS للنشر ولا يخزن في browser storage.
- لا يعاد المفتاح بعد الإنشاء؛ GET يعيد `has_key` فقط.
- ترك الحقل فارغاً في edit يعني «احتفظ بالحالي»، وليس «خزّن فارغاً».
- المسح والاستبدال فعلان صريحان.
- استخدم primitive التشفير الحالي AES-256-GCM إن كان صالحاً، مع versioned envelope وخطة تدوير master key.
- لا تستخدم key fingerprint مشتقاً مباشرة بلا HMAC إذا كان يمكن إجراء تخمين؛ إن كانت الحاجة مجرد invalidation، استخدم HMAC بمفتاح خادم أو random version.
- plaintext يعيش أقصر فترة لازمة ولا يُضمّن في exception context.
- redaction يشمل القيم بعد URL encoding وJSON serialization حيث يمكن.

### 3.3 اختبار منع التسرب

- افحص API snapshots لغياب `api_key`, `encrypted_api_key`, `authorization`.
- اختبر logger spy عند أخطاء fetch/decrypt/provider.
- افحص rendered HTML/React props.
- لا تطبع request body في middleware debugging.
- لا تضع السر في query string إلا إذا فرض Gemini strategy ذلك؛ عندها يبني الخادم URL ولا يسجله، ويفضل header إن كانت الواجهة الرسمية تدعمه.

## 4. سياسة SSRF والاتصال الصادر

### 4.1 خوارزمية قرار الوجهة

1.  حل preset على الخادم.
2.  إن كان preset ثابتاً، قارن root بالقيمة server-side ولا تقبل override.
3.  Parse بواسطة `URL`; ارفض parsing غير الحتمي.
4.  ارفض username/password/fragment.
5.  افرض `https:` للوجهات العامة؛ `http:` لا يسمح إلا deployment allowlist محددة في self-hosted.
6.  افرض port allowlist؛ الافتراضي 443، والاستثناءات server-configured.
7.  طبّع host إلى ASCII/IDNA وخفض case وأزل trailing dot حيث يلزم.
8.  ارفض hostname patterns المحظورة، لكن لا تعتمد عليها وحدها.
9.  Resolve كل A وAAAA.
10. ارفض إذا أعاد أي عنوان نطاقاً محظوراً، وليس فقط أول عنوان.
11. ثبّت destination قدر الإمكان في طبقة النقل أو استخدم egress proxy؛ الفحص ثم fetch عادي قد يبقى معرضاً لـ DNS rebinding/TOCTOU.
12. استخدم `redirect: manual`. إذا سُمح redirect، كرر الخوارزمية لكل hop وحدد العدد.
13. طبق timeout وresponse-size limit أثناء streaming، قبل `json()` الكامل.
14. أغلق/ألغ الطلب عند تجاوز الحد.

### 4.2 نطاقات يجب حجبها افتراضياً

- IPv4 loopback وprivate وlink-local وcarrier-grade NAT وmulticast وunspecified وdocumentation/reserved حسب مكتبة IP موثوقة.
- IPv6 loopback وunique-local وlink-local وmulticast وunspecified وreserved.
- IPv4-mapped IPv6 التي تشير إلى نطاق محظور.
- cloud metadata endpoints المعروفة، مع الاعتماد أولاً على تصنيف IP لا أسماء فقط.
- localhost وأشكاله والتدوينات الرقمية الغريبة بعد canonicalization.

لا تكتب parser IP منزلياً إذا توفر primitive موثوق في runtime/تبعية موجودة. أي تبعية جديدة تحتاج مراجعة وصيانة.

### 4.3 DNS rebinding

حل DNS ثم استدعاء `fetch(hostname)` قد يعيد الحل إلى عنوان مختلف. الخيارات مرتبة:

1.  egress proxy/firewall يطبق allowlist/CIDR ويمنع metadata على مستوى الشبكة.
2.  transport/dispatcher يربط الاتصال بعنوان resolved ومراجع مع الحفاظ على TLS SNI/Host والتحقق من الشهادة.
3.  allowlist hosts ثابتة للمزوّدات العامة، مع منع custom في SaaS حتى توفر حماية أقوى.

لا تصف validation سطحي بأنه «محصّن تماماً» من SSRF. وثق طبقة النشر المطلوبة.

### 4.4 9Router والبوابات الخاصة

إعدادات مقترحة على مستوى deployment، بأسماء يحددها المشروع:

``` text
AI_CUSTOM_ENDPOINTS_ENABLED=false
AI_PRIVATE_ENDPOINTS_ENABLED=false
AI_ENDPOINT_ALLOWLIST=api.example.com:443
```

لا تجعل هذه القيم قابلة للتغيير من حساب مستأجر. عند تفعيل private endpoints:

- استخدم exact host/IP وport، لا wildcard واسعاً.
- اعزل WACRM عن شبكات الإدارة والmetadata بجدار ناري.
- بين للمستخدم أن الاتصال deployment-scoped.
- لا تشحن قيمة localhost مفعلة افتراضياً.

## 5. مصادقة المزوّد

- OpenAI-compatible غالباً Bearer؛ لا تسمح للمستخدم بتغيير اسم header في الإصدار الأول.
- Anthropic يستخدم headers الرسمية التي يضيفها adapter، ومنها version من قيمة server-defined مختبرة.
- Gemini auth يتبع الواجهة الرسمية المستخدمة؛ السر يبقى على الخادم.
- لا تخلط provider 401 مع session 401.
- لا تسجل header عند retries أو exceptions.

## 6. Validation المدخلات والمخرجات

### المدخلات

- connection name: trim، طول أقصى، منع control characters.
- model ID: trim، طول أقصى، منع CR/LF؛ لا تفرض regex ضيقاً يكسر IDs صحيحة.
- API root: طول أقصى وURL policy.
- system prompt: حافظ على الحدود الحالية أو وثق تغييرها؛ لا يدخل في probe logs.
- pagination token من المزوّد لا يعرض للعميل ولا يستخدم خارج نفس host/path contract.

### المخرجات

- JSON فقط ضمن الحجم المتوقع.
- عدد أقصى للـ models والصفحات.
- model field lengths محدودة قبل التخزين/العرض.
- إزالة حقول غير لازمة من payload.
- حماية UI من النصوص غير الموثوقة بالاعتماد على React escaping وعدم استخدام HTML خام.

## 7. ضبط التكلفة وإساءة الاستخدام

- rate limit لكل user وaccount وconnection، لا IP فقط.
- حدود منفصلة لـ discover وtest وgenerate/embed.
- test model لا يعمل تلقائياً عند فتح الشاشة.
- save لسلوك غير متعلق بالاعتماد لا يعيد probe.
- debounce وحده ليس حماية خادم.
- concurrency gate يمنع عشرات discovery calls المتزامنة لنفس الاتصال.
- cache يشارك النتيجة داخل الحساب والاتصال.
- backoff للـ 429 في discovery فقط ضمن سقف؛ generation يعود للمستهلك بلا retry تلقائي.
- budget/circuit breaker اختياري للمستقبل، لكن observability يجب أن تسمح بإضافته.

## 8. سياسة الأخطاء والسجلات

### سجل آمن نموذجي

``` json
{
  "event": "ai.provider.request.failed",
  "request_id": "req_...",
  "account_id_hash": "...",
  "connection_id": "...",
  "protocol": "openai_compatible",
  "operation": "list_models",
  "status": 429,
  "code": "AI_RATE_LIMITED",
  "latency_ms": 820,
  "retryable": true
}
```

ممنوع إضافة `headers`, `body`, `prompt`, `response_text`, `api_key`, `full_url_with_query`.

### provider error bodies

- يمكن تحليل حقول code/type المعروفة ضمن size limit.
- تمر عبر redactor.
- لا تُخزن كاملة افتراضياً.
- message العام يختار من mapping داخلي.
- request ID يسمح بربط الدعم بالسجل.

## 9. RLS وقاعدة البيانات

قائمة مراجعة لكل policy/RPC:

- account membership مستخدمة بنفس النمط الموثوق في المشروع.
- member لا يقرأ ciphertext حتى لو استطاع قراءة metadata.
- admin mutation يتحقق مرتين: route وdatabase policy حيث يمكن.
- service role client لا يمر إلى browser.
- `SECURITY DEFINER` مع `set search_path` وqualification للأسماء.
- revoke execute from public ثم grant أقل صلاحية.
- FK لا يسمح بربط config لاتصال حساب آخر.
- حذف account يمسح secrets وفق السياسة الحالية.
- backup access وretention للأسرار موثقان.

## 10. الاعتمادية

### timeouts

عرّف budget لكل عملية، مثلاً:

- discovery: مدة إجمالية أطول قليلاً بسبب pagination، مع حد لكل صفحة.
- test: قصيرة وبطلب صغير.
- generation: الإعداد الحالي أو قيمة server-controlled.
- embeddings batch: حسب الحجم ضمن السقف.

الأرقام النهائية تُضبط بعد قياس؛ لا يقبل timeout من العميل.

### retries

| العملية               | الافتراضي                                                               |
|-----------------------|-------------------------------------------------------------------------|
| list models GET       | 1–2 bounded retries على 408/429/5xx/network المؤقت                      |
| connection auth probe | retry محدود فقط إن كان idempotent                                       |
| chat generation       | لا retry تلقائي                                                         |
| embeddings ingest     | retry على مستوى job/chunk بإدempotency واضحة، لا حلقة داخلية غير محدودة |
| DB transaction        | حسب نمط المشروع وتعارضات معروفة فقط                                     |

### circuit breaking

ليس إلزامياً للإصدار الأول، لكن لا تُخفِ الحالة. يمكن تخفيض الضغط على مزوّد فاشل عبر cache وrate limits، ثم إضافة circuit breaker بقرار لاحق.

## 11. تشغيل وترحيل آمن

### قبل النشر

- backup واختبار restore وفق سياسة المشروع.
- تشغيل migration على نسخة staging ببيانات قديمة ممثلة.
- counts قبل/بعد: configs، connections، configs بلا connection، decrypt failures.
- لا تطبع IDs/أسرار أكثر من اللازم في تقرير التشغيل.
- feature flag افتراضياً off.
- التحقق من متغيرات encryption وoutbound policy.

### canary

- تفعيل لحساب داخلي أو نسبة صغيرة.
- مقارنة نجاح OpenAI/Anthropic والـ latency.
- مراقبة config load/decrypt/backfill failures.
- اختبار rollback إلى read القديم.

### التوسع

- دفعات تدريجية.
- عدم تشغيل backfill ثقيل ضمن request عادي.
- مراقبة Supabase locks وAPI limits.
- إبقاء الأعمدة القديمة خلال نافذة الرجوع.

## 12. Runbooks

### 12.1 اشتباه تسرب مفتاح

1.  لا تطبع المفتاح للتحقق.
2.  حدّد connection/request IDs من metadata.
3.  عطّل الاتصال أو preset المتأثر.
4.  اطلب تدوير مفتاح المزوّد من مالكه.
5.  راجع logs/traces/caches/backups لمواضع التسرب وفق الصلاحيات.
6.  أصلح المسار وأضف regression test.
7.  وثق الحادث وفق سياسة المشروع.

### 12.2 ارتفاع SSRF blocks

1.  راجع codes والوجهات بعد تنقيحها.
2.  لا توسع allowlist فوراً بناء على طلب مستأجر واحد.
3.  تحقق هل preset الرسمي تغيّر.
4.  إن كانت بوابة خاصة شرعية، عالجها بإعداد deployment وضوابط شبكة.
5.  اختبر redirect/DNS قبل التفعيل.

### 12.3 فشل model discovery

1.  تحقق من endpoint الرسمي/version/pagination.
2.  أبق cache stale وmanual entry.
3.  لا تعطل generation العامل.
4.  افصل 401 عن 404 unsupported وعن 429 مؤقت.
5.  حدّث preset/adapter مع contract fixture.

### 12.4 فشل Embeddings أو mismatch

1.  لا تكتب vector المخالف.
2.  لا تحول revision النشطة.
3.  استمر على القديمة أو lexical fallback.
4.  تحقق من dimensions parameter الرسمي والنموذج.
5.  أعد job المتأثر بعد الإصلاح، لا كامل البيانات بلا حاجة.

### 12.5 فشل migration/backfill

1.  أوقف feature flag والتحويل، لا تنفذ حذفاً عكسياً متسرعاً.
2.  حافظ على القراءة القديمة.
3.  استخرج counts ورموز الخطأ المنقحة.
4.  أصلح backfill idempotent وأعد تشغيل الصفوف الفاشلة.
5.  لا تنتقل إلى contract phase.

## 13. قائمة مراجعة أمنية قبل الإصدار

- [ ] Threat model محدث بعد الكود النهائي.

- [ ] ثابت أن المتصفح لا يتصل بالمزوّد.

- [ ] لا secrets في responses/logs/errors/DOM/tests fixtures الحقيقية.

- [ ] fixed presets لا تقبل override.

- [ ] custom endpoints off أو مقيدة حسب deployment.

- [ ] IPv4/IPv6/redirect/DNS rebinding strategy موثقة ومختبرة.

- [ ] RLS cross-account tests تمر.

- [ ] admin role tests تمر.

- [ ] rate/concurrency/time/size limits موجودة.

- [ ] provider errors منقحة.

- [ ] generation retries معطلة افتراضياً.

- [ ] embedding dimensions validated قبل DB write.

- [ ] rollback وfeature flag مجربان.

- [ ] dependencies الجديدة، إن وجدت، مراجعة ومثبتة بإصدارات متوافقة.

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

| الطبقة              | الغرض               | أمثلة                                             |
|---------------------|---------------------|---------------------------------------------------|
| Unit                | منطق نقي سريع       | URL joins، normalizers، error maps، dimensions    |
| Adapter contract    | توافق wire protocol | headers، paths، payloads، pagination، usage       |
| Service integration | business rules      | invalidation، cache، ownership، transactions      |
| Database/RLS        | العزل والترحيل      | policies، cross-account، backfill، constraints    |
| API route           | auth وDTOs          | status، error envelope، no-secret response        |
| Component/UI        | سلوك النموذج        | manual entry، stale state، masking، accessibility |
| End-to-end محدود    | رحلة إعداد كاملة    | create → discover → select → test → save          |

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

لكل endpoint، غطِّ:

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

| المتطلب                      | الدليل الأدنى                                              |
|------------------------------|------------------------------------------------------------|
| OBJ-01 التوافق الخلفي        | migration fixtures + OpenAI/Anthropic regression           |
| OBJ-02 OpenAI-compatible     | adapter contract مع مزوّدين مختلفين + custom root           |
| OBJ-03 Gemini Native         | native adapter/model pagination/generate fixtures          |
| OBJ-04 dynamic models/manual | catalog service + UI tests للفشل والغياب                   |
| OBJ-05 فصل Chat/Embeddings   | DB/API/E2E باتصالين مختلفين                                |
| OBJ-06 حماية الأسرار         | response/log/DOM negative assertions                       |
| OBJ-07 SSRF                  | IPv4/IPv6/DNS/redirect/port/scheme tests + deployment docs |
| OBJ-08 ترحيل قابل للرجوع     | idempotent backfill + flag rollback rehearsal              |
| OBJ-09 قابلية التوسع         | registry/preset tests ووثيقة إضافة مزوّد                    |
| OBJ-10 UX الحالة             | component tests لـ verified/stale/error/manual             |
| FR-CON-07 حذف آمن            | reference conflict/transaction tests                       |
| FR-MOD-06 cache stale        | stale-on-error service/API/UI tests                        |
| Embedding 1536               | dimension tests قبل أي insert/RPC                          |
| عدم retry للتوليد            | transport call count = 1 على timeout                       |

## 9. سيناريوهات قبول Gherkin مختصرة

### مزوّد لا يدعم `/models`

``` gherkin
Given an admin has a valid custom OpenAI-compatible connection
And its models endpoint returns 404
When the admin enters a model ID manually and tests it
And chat completion succeeds
Then the connection can be selected for chat
And the UI does not claim model discovery succeeded
And no cached catalog is erased
```

### كتالوج قديم

``` gherkin
Given a connection has a successful cached model catalog
When a forced refresh times out
Then the last catalog remains available and marked stale
And the saved model remains selected
And the response includes a safe retryable error code
```

### منع SSRF

``` gherkin
Given private endpoints are disabled for the deployment
When an admin submits a custom root that resolves to a private address
Then WACRM rejects it before sending provider credentials
And no redirect or fallback request is made
And the audit event contains no credential or raw URL secret
```

### Embedding غير متوافق

``` gherkin
Given the current knowledge index requires 1536 dimensions
When the selected embedding model returns a 3072-element vector
Then WACRM rejects activation with AI_EMBEDDING_DIMENSION_MISMATCH
And no incompatible vector is persisted
And the previous semantic revision or lexical fallback remains active
```

### ترحيل حساب قديم

``` gherkin
Given an existing Anthropic chat config and a separate OpenAI embeddings key
When the backfill runs twice
Then exactly two appropriate connections exist
And chat and embeddings selections preserve their behavior
And the old config remains readable during rollback
And no plaintext key appears in output or logs
```

## 10. أوامر التحقق

استخدم الأوامر الموجودة فعلياً في `package.json`. في اللقطة المرجعية كانت:

``` bash
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

# خطة التنفيذ المرحلية

**الحالة:** Normative  
**الهدف:** إبقاء التغيير قابلاً للمراجعة والرجوع، مع فصل refactor عن توسعة السلوك وترحيل البيانات.

## 1. قواعد عامة

- فرع واحد مخصص للمبادرة، وdiff صغير لكل مرحلة/PR حسب سياسة الفريق.
- لا كتابة فوق تغييرات محلية أو unrelated cleanup.
- لا تغيير dependencies إلا بعد إثبات الحاجة وADR عند الأثر المعماري.
- كل migration جديد يحمل الرقم التالي الفعلي؛ لا تعدّل migrations مطبقة.
- لا real provider calls في CI الافتراضي.
- لا deploy أو push أو commit أو production migration بلا تفويض صريح.
- كل مرحلة تنتهي بتقرير القالب ونتائج أوامر فعلية.

## 2. خريطة الاعتماد

``` mermaid
flowchart TD
  P0["00 Reconnaissance"] --> P1["01 Foundation"]
  P1 --> P2["02 Connections + security"]
  P2 --> P3["03 OpenAI-compatible"]
  P2 --> P4["04 Anthropic + Gemini"]
  P3 --> P5["05 Embeddings + UX"]
  P4 --> P5
  P5 --> P6["06 Hardening + release"]
```

يمكن تنفيذ بعض أعمال المرحلة 03 و04 بالتوازي بشرياً بعد استقرار العقود، لكن لا تدمجها قبل اجتياز اختبارات Registry/Connection/Outbound المشتركة.

## 3. المرحلة 00: الاستكشاف وتجميد خط الأساس

### الهدف

بناء صورة دقيقة للفرع المحلي قبل أي تغيير.

### الأعمال

- قراءة `AGENTS.md`, `CLAUDE.md`, README، ومساهمات/تعليمات متداخلة.
- فحص branch/commit/status وعدم تعديل ملفات المستخدم.
- قراءة package scripts والإصدارات.
- رسم call graph لـ config → generate → provider، وknowledge ingest/retrieval → embeddings.
- فحص migrations/RLS/RPCs والـ dimensions.
- فحص UI/i18n ومعدل الحدود/error contracts/encryption.
- البحث عن عمل متداخل أو PR محلي/remote ذي صلة إن كانت الشبكة والتفويض يسمحان.
- تدوين الانحرافات عن هذه الحزمة.

### المخرجات

- تقرير `phase-00-current-state.md`.
- قائمة ملفات متوقعة per phase.
- مخاطر/أسئلة/قرارات مطلوبة.
- لا تعديل كود منتج.

### البوابة

- لا تغييرات محلية متداخلة غير مفهومة.
- رقم migration وخطة backfill معروفان.
- قيد embeddings الفعلي مؤكد.
- تعليمات Next.js الفعلية مقروءة.

## 4. المرحلة 01: الأساس من دون تغيير السلوك

### الهدف

إزالة `switch` الخاص بالمزوّد لصالح عقود وRegistry مع بقاء OpenAI وAnthropic فقط وظيفياً.

### الأعمال

- تعريف `ProviderProtocol`, adapter interfaces، normalized errors/capabilities.
- نقل OpenAI وAnthropic الحاليين إلى Registry بأقل diff.
- استخراج network/error helpers المشتركة من دون custom URL بعد.
- الحفاظ على public `generateReply` contract أو adapter shim للتوافق.
- إضافة tests للـ registry والعقد والانحدار والusage/handoff.

### غير مسموح

- migration.
- تغيير UI.
- إضافة Gemini/DeepSeek.
- base URL من المستخدم.
- تغيير سلوك embeddings.

### البوابة

- OpenAI/Anthropic fixtures تعطي النتائج نفسها.
- call sites الحالية لا تعرف adapter.
- جميع فحوص المشروع تمر.

### rollback

إرجاع refactor المعزول؛ لا بيانات تغيرت.

## 5. المرحلة 02: الاتصالات والأمن والبيانات additive

### الهدف

إنشاء Connection entity وخدمة آمنة وسياسة outbound، من دون تحويل كل المستهلكين بعد.

### الأعمال

- migration additive للجداول/الأعمدة/RLS/constraints.
- safe DTO وserver-only loader.
- encrypt/decrypt reuse/versioning.
- preset registry والسياسات fixed/custom/opt-in.
- outbound URL policy وtransport wrapper.
- CRUD routes وauthorization/rate limits.
- backfill tooling/SQL idempotent لكن لا contract deletion.
- feature flag وfallback loader.

### البوابة

- cross-account/RLS tests.
- secret leakage tests.
- SSRF matrix.
- backfill twice بلا duplicates.
- old config remains readable.

### rollback

flag off واستخدام الأعمدة القديمة؛ schema الجديد يبقى غير مستخدم. لا drop طارئ.

## 6. المرحلة 03: OpenAI-compatible وModel discovery

### الهدف

تعميم OpenAI الحالي وإضافة presets ذات صلة، مع catalog اختياري.

### الأعمال

- API root آمن في runtime connection.
- paths مبنية نسبياً بلا double version.
- list models normalizer وحدود/cache/stale behavior.
- presets: OpenAI وDeepSeek، وأي preset آخر مؤكد في قرار النطاق.
- Custom OpenAI-compatible حسب deployment policy.
- 9Router preset/guide opt-in فقط إن قرر المنتج إظهاره.
- test connection وtest model منفصلان.
- contract fixtures لمزوّد standard وآخر ذي اختلافات وendpoint بلا models.

### البوابة

- OpenAI regression كامل.
- خدمة models=404 + chat=success تعمل يدوياً.
- fixed preset override مرفوض.
- cache invalidation/stale-on-error تمر.
- لا real key مطلوب.

### rollback

تعطيل presets الجديدة؛ OpenAI القديم عبر adapter نفسه يبقى.

## 7. المرحلة 04: Anthropic-compatible وGemini Native

### الهدف

استكمال البروتوكولات الأساسية مع pagination وقدرات أصلية.

### الأعمال

- Anthropic adapter ضمن Registry مع سلوكه الحالي محفوظاً.
- Anthropic list models الرسمي وpagination bounded.
- قرار واضح هل يعرض Custom Anthropic-compatible الآن أم يؤجل.
- Gemini Native generate/list models، وتأسيس embed capability من دون تحويل الفهرس بعد.
- تطبيع Gemini IDs وsupported methods/token limits.
- error/usage mapping.

### البوابة

- Anthropic regression، بما فيه consecutive roles.
- pagination boundaries.
- Gemini native fixtures لـ generate/models/errors.
- لا مزج بين OpenAI compatibility وNative contracts.

### rollback

تعطيل Gemini preset؛ Anthropic الحالي يبقى في Registry.

## 8. المرحلة 05: Embeddings وUX الكامل

### الهدف

فصل Chat/Embeddings، تطبيق dimension gate/re-index، وتقديم واجهة آمنة ومفهومة.

### الأعمال الخلفية

- generic embed contract للمهايئات التي تدعمه.
- حفظ embedding model/dimensions/revision.
- test صغير يقيس البُعد.
- رفض أي vector غير متوافق قبل DB/RPC.
- backfill إعداد OpenAI embeddings الحالي.
- تصميم re-index state/job أو البديل المحافظ الموثق.
- lexical fallback محفوظ.

### أعمال الواجهة

- إدارة connections.
- preset/root/key masking.
- verify/load models.
- searchable list + manual input.
- fresh/stale/error/saved-missing states.
- Chat وEmbeddings selectors منفصلان.
- re-index warning/progress.
- كل locales وaccessibility.

### البوابة

- 1536 pass، وأبعاد أخرى fail بلا write.
- اتصالان مختلفان لـ Chat/Embeddings.
- UI لا يرسل placeholder أو يمسح model.
- current OpenAI embeddings accounts continue.
- semantic revision activation atomic أو fallback conservative مثبت.

### rollback

العودة إلى embedding config القديم تحت flag، أو lexical fallback؛ لا حذف vectors القديمة قبل نافذة الاستقرار.

## 9. المرحلة 06: التقسية والإطلاق

### الهدف

دمج المسارات، إغلاق الثغرات، تجهيز التشغيل والإصدار التدريجي.

### الأعمال

- E2E محدود لرحلات الإعداد.
- full regression وproduction build.
- redaction/security review.
- performance/limits for catalogs and batches.
- observability dashboards/queries حسب أدوات المشروع.
- migration rehearsal، counts، rollback rehearsal.
- docs: architecture, add-provider, admin guide, deployment env, runbook, release notes.
- canary flag وخطة rollout.
- مراجعة TODOs والـ dual-read expiry owner/date.

### البوابة

- كل معيار قبول في الوثيقة الرئيسية له دليل.
- لا high-severity finding مفتوح.
- rollback مجرب.
- owner واضح للحذف اللاحق للأعمدة القديمة.
- موافقة بشرية قبل production.

## 10. Contract phase اللاحقة

ليست جزءاً تلقائياً من المراحل الست. بعد نافذة استقرار:

- تحقق أن لا fallback reads.
- backup وموافقة.
- حذف الأسرار/الأعمدة القديمة في migration مستقل.
- إزالة dual-write وfeature flag المتقادم.
- تحديث الوثائق وdata retention.

## 11. نقاط توقف إلزامية

يتوقف الوكيل ويطلب قراراً إذا:

- `git status` يحتوي تعديلات تتداخل مع الملفات المقصودة ولا يعرف مصدرها.
- فرع المشروع نفذ تصميماً مختلفاً جوهرياً أو PR قريباً من الدمج.
- migration قد يحذف أو يعيد تشفير أسرار بلا rollback.
- يلزم مفتاح حقيقي أو استهلاك مدفوع لإكمال الاختبار.
- يلزم السماح private network في بيئة غير معروفة.
- لا يمكن حماية DNS rebinding لكن المنتج يطلب custom arbitrary URLs في SaaS.
- قرار multi-dimension embeddings مطلوب الآن.
- tests الأساسية تفشل قبل التغيير ولا يمكن عزل السبب.
- يتطلب التنفيذ deploy/push/production access غير مفوض.

## 12. تقرير المرحلة

بعد كل مرحلة، أنشئ تقريراً من `templates/PHASE_REPORT_TEMPLATE.md`. يجب أن يذكر الأوامر ونتائجها لا عبارة عامة، ويضع روابط/مسارات الملفات ويشرح rollback فعلياً.

# برومبت المرحلة 00 — الاستكشاف وخطة التنفيذ

انسخ هذا البرومبت إلى وكيل البرمجة وهو داخل مستودع WACRM. لا تستخدمه بعد أن بدأ الوكيل تعديلات غير مراجعة؛ اجعله أول خطوة.

``` text
نفّذ المرحلة 00 فقط من مشروع تعدد مزوّدي الذكاء الاصطناعي. هذه مرحلة قراءة وتحليل؛ لا تعدل كود المنتج، ولا تنشئ migration، ولا تثبت dependencies، ولا تعمل commit/push/deploy.

المراجع الملزمة بالترتيب:
1. تعليمات المستودع المحلية (AGENTS.md وCLAUDE.md وأي ملفات تعليمات متداخلة).
2. docs/ai-multi-provider/WACRM_MULTI_PROVIDER_MASTER.md.
3. architecture/TARGET_ARCHITECTURE.md وDATA_AND_API_CONTRACTS.md وDECISIONS.md.
4. delivery/SECURITY_AND_OPERATIONS.md وTEST_AND_ACCEPTANCE_MATRIX.md وIMPLEMENTATION_ROADMAP.md.

المهام:

A) سلامة مساحة العمل
- اعرض الفرع والالتزام الحاليين، وملخص git status.
- صنف التغييرات الموجودة: متداخلة مع AI أم غير متداخلة. لا تعرض أسراراً أو محتوى env.
- اقرأ كل تعليمات المستودع ذات الصلة. إذا كانت تعليمات Next.js تطلب قراءة docs محلية، حدد الملفات المناسبة واقرأها قبل اقتراح أي تغيير.
- حدد package manager ونسخ Node/Next/React/TypeScript/Supabase/Vitest والأوامر الفعلية.

B) خريطة التنفيذ الحالي
- تتبع كل call site لتوليد AI: draft، auto-reply، test، وأي مسارات أخرى.
- وثق أنواع config/provider/messages/results/errors/usage.
- وثق OpenAI وAnthropic URLs/headers/request bodies/normalization/timeouts.
- تتبع التشفير وفك التشفير ومكان خروج المفتاح للذاكرة.
- تتبع API config GET/POST/DELETE وصلاحياتها وrate limits وشكل DTO.
- تتبع Settings UI وlocales، مع ذكر كل ملف ترجمة يتطلب تحديثاً.
- تتبع embeddings ingest/retrieval/model/dimensions/pgvector/RPC/index/fallback.
- اقرأ migrations الخاصة بـ AI وRLS والـ helper functions، وحدد رقم migration التالي من الفرع الفعلي.
- تتبع logs/observability واختبارات AI الحالية.

C) التداخل والمخاطر
- ابحث في الفرع والتاريخ/الفروع المتاحة عن عمل متداخل يتعلق بـ providers أو DeepSeek أو Gemini أو agents. لا تدمج أو cherry-pick.
- قارن الوضع الفعلي مع لقطة المرجع في الوثيقة، وصنف الفروق: مؤثر/غير مؤثر.
- حدد أي كود يمرر provider error raw أو يسمح بتسرب سر أو يثبت dimension.
- حدد كيف سيعمل rollback من دون حذف بيانات.

D) خطة ملفات دقيقة
- اقترح files to add/modify لكل مرحلة 01–06.
- افصل refactor بلا تغيير سلوك عن schema والميزات.
- اذكر الاختبارات التي ستنشأ قبل/مع كل تعديل.
- اذكر القرارات التي تتطلب موافقة بشرية، إن وجدت.

المخرج الوحيد المطلوب:
أنشئ/اكتب تقريراً باسم docs/implementation/ai-multi-provider/phase-00-current-state.md (أو اعرض محتواه إذا لم يكن مسموحاً تعديل docs في هذه المرحلة) ويحتوي:
- Metadata: branch, commit, date, package versions.
- Workspace status منقح.
- Current architecture call graph.
- Database/RLS/embeddings facts.
- Security and migration risks.
- Gap table مقابل كل قرار رئيسي في المواصفات.
- Exact phase-by-phase file plan.
- Baseline verification commands and actual results إن كانت read-only وآمنة.
- Blockers/questions.
- Recommendation: GO أو STOP مع السبب.

قواعد الأدلة:
- استشهد بمسارات ورموز فعلية، لا تخمينات.
- لا تدّع أن اختباراً مر إن لم تشغله.
- لا تطبع env أو API keys أو ciphertext.
- إذا وجدت تغييرات متداخلة مجهولة أو خطر فقد بيانات، أعط STOP ولا تبدأ المرحلة 01.

توقف بعد التقرير وانتظر المراجعة. لا تنفذ المرحلة التالية.
```

## بوابة المراجعة البشرية

قبل قبول التقرير، تحقق أن الوكيل ذكر قيد أبعاد embeddings، وسياسة base URLs، وخطة البيانات القديمة، وأي تغييرات محلية. إن أغفل واحداً منها، أعد المرحلة قبل السماح بالكود.

# برومبت المرحلة 01 — العقود وRegistry مع الحفاظ على السلوك

``` text
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

# برومبت المرحلة 02 — Connection entity والأمن والترحيل الإضافي

``` text
نفّذ المرحلة 02 فقط بعد قبول المرحلة 01. الهدف إضافة بنية الاتصالات وخدمة الخادم وسياسة outbound ومخطط additive قابل للرجوع. لا تحول كل الإنتاج إلى البنية الجديدة ولا تضف Gemini/DeepSeek behavior بعد.

ابدأ بمراجعة تقرير المرحلة السابقة، رقم migration الحالي، ونمط RLS/encryption/rate limiting في الفرع. أي SQL في وثائق التصميم توجيهي ويجب مواءمته.

المطلوب:

1) البيانات
- أضف migration جديدة فقط؛ لا تعدل migration مطبقة.
- أنشئ ai_provider_connections أو الاسم المتوافق مع المشروع، بالملكية account_id والحقول والقيود اللازمة.
- أضف أعمدة روابط Chat/Embeddings إلى config بصورة nullable في مرحلة expand.
- لا تحذف provider/model/api_key/embeddings_api_key القديمة.
- اختر on-delete behavior محافظاً يمنع الحذف العرضي.
- أضف RLS/policies/RPCs وفق أنماط المشروع، مع منع ciphertext عن client reads.
- أي SECURITY DEFINER يحدد search_path ويسحب PUBLIC.

2) Connection domain/service
- SafeConnection DTO منفصل عن RuntimeConnection server-only.
- CRUD مع ownership وadmin role.
- ترك key غائباً عند patch يبقي الحالي؛ لا تقبل masked placeholder.
- استبدال المفتاح ذرّي؛ فشل التحقق لا يمسح القديم.
- fingerprint/version آمن يستخدم invalidation ولا يكشف السر.
- fixed preset root لا يقبل override حتى مع payload يدوي.

3) Presets والسياسات
- أنشئ registry declarative مبدئياً للمزوّدين الحاليين، مع بنية تسمح بالـ custom/opt-in لاحقاً.
- protocol/auth strategy/server defaults لا تأتي من client.
- لا تسمح headers مخصصة حرة.

4) Outbound policy
- طبقة مركزية لكل custom provider request: parse/canonicalize/scheme/port/DNS A+AAAA/IP classes/redirect manual/time/bytes.
- احجب loopback/private/link-local/metadata/multicast/unspecified/CGNAT وIPv4-mapped IPv6.
- وثق معالجة DNS rebinding بصدق؛ إذا runtime transport لا يستطيع pinning، اجعل arbitrary custom URLs غير مفعلة افتراضياً وأضف deployment allowlist/egress requirement.
- 9Router/local endpoints off افتراضياً، ولا يوجد per-account bypass.
- صمم resolver/transport كاعتماد قابل للحقن لاختباره deterministically.

5) API
- CRUD routes server-only، auth/role/rate limit/validation/error envelope.
- GET يعيد metadata آمنة فقط.
- لا تنفذ model discovery الحقيقي بعد، لكن ضع service seams إن لزم.

6) Backfill وcompatibility
- أنشئ backfill idempotent أو خطة قابلة للتنفيذ والاختبار تحول configs القديمة إلى connections.
- حافظ على loader/fallback للقديم تحت feature flag.
- لا تشغل backfill إنتاجي.
- لا تفك/تطبع أسراراً في logs. اختبر legacy encryption إن كان مدعوماً.

الاختبارات الإلزامية:
- RLS cross-account وmember/admin لكل عملية.
- safe DTO recursive no-secret assertions.
- create/patch/failed-replace/delete-in-use.
- fixed root override rejection.
- SSRF: schemes, ports, IPv4/IPv6 classes, mapped IPv6, multi-answer DNS, redirects.
- response size and timeout.
- backfill old OpenAI/Anthropic/embeddings configs مرتين بلا duplicates.
- fallback/feature flag rollback.

لا تفعل:
- لا تسجل مفاتيح حقيقية.
- لا تضف UI كامل أو provider presets جديدة تعمل.
- لا تبدل production reads نهائياً.
- لا تسقط الأعمدة القديمة.
- لا تضف خيار Allow localhost في UI.

التحقق والمخرج:
- شغّل كل scripts الفعلية، وSQL verification المتاح في المشروع.
- حدث env example بأسماء flags/allowlist من دون قيم حساسة، ووثق defaults الآمنة.
- اكتب phase-02-connections-security.md وفق القالب، وأدرج migration forward behavior وrollback الفعلي وطبقات SSRF المتاحة/الناقصة.
- توقف؛ لا تبدأ المرحلة 03.
```

## بوابة القبول

- قاعدة البيانات additive وقابلة للتعايش.
- لا ciphertext في مسار قراءة العميل.
- سياسة SSRF مختبرة وليست regex للـ hostname فقط.
- backfill idempotent والرجوع إلى loader القديم ممكن.

# برومبت المرحلة 03 — OpenAI-compatible وكتالوج النماذج

``` text
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

# برومبت المرحلة 04 — Anthropic وGemini Native

``` text
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

# برومبت المرحلة 05 — Embeddings وتجربة الإعدادات

``` text
نفّذ المرحلة 05 فقط بعد قبول adapters والاتصالات. الهدف فصل Chat عن Embeddings بأمان، تطبيق قيد الأبعاد وإدارة re-index، ثم بناء UX متكامل لاكتشاف/اختيار النماذج. لا تغيّر بُعد قاعدة البيانات عشوائياً.

الخطوة الأولى الإلزامية:
- أعد التحقق من schema/RPC/index الفعلي للـ pgvector ومن كل موضع يثبت النموذج أو 1536.
- قدم قرار تنفيذ قصير: (أ) revision مزدوجة مع atomic activation، أو (ب) تعطيل semantic مؤقتاً ثم full re-index ثم تفعيل. اختر الأبسط الآمن الذي يناسب بنية المشروع، وسجل أي انحراف في ADR.

Backend — Embeddings:
- استخدم adapter `embed` العام للمزوّدات التي تدعمه فعلاً.
- افصل embedding_connection_id/model عن chat connection/model.
- مرر dimensions option فقط إذا كان البروتوكول/المزوّد يدعمه رسمياً؛ لا تفترض.
- test embedding بإدخال ثابت غير حساس، ثم تحقق من عدد النتائج، القيم finite، وطول كل vector.
- لمسار الفهرس الحالي اقبل 1536 فقط.
- لا truncate ولا pad ولا mix.
- احفظ model/dimensions/revision وحالة التوافق/آخر تحقق.
- تغيير connection/model/dimensions/options يجعل revision جديدة ويطلب re-index.
- حافظ على lexical fallback، وعلى semantic revision السابقة حتى نجاح الجديدة إن كان التصميم يسمح.
- batch/retry على مستوى job وبحدود واضحة؛ لا retry loop غير محدود.
- backfill مفتاح/نموذج OpenAI embeddings الحالي من دون طلب إعادة إدخال إن أمكن بأمان.

Backend — Config/API:
- تحديث config ذرّي، والتحقق من ملكية connection للحساب.
- لا تفعل semantic config غير مختبر.
- status واضح لـ pending/building/ready/failed أو البديل المحافظ.
- لا تحذف vectors/revision قديمة في الإصدار نفسه.

Frontend — Connections:
- قائمة/إنشاء/تعديل/تعطيل/حذف الاتصالات وفق الصلاحيات.
- preset selector، root read-only للثابت وcustom فقط عند السماح.
- key masked، فارغ عند edit، ولا يرسل placeholder.
- زر Verify & load models، مع loading/success/error/request ID الآمن.

Frontend — Models:
- searchable select من normalized catalog.
- manual model ID متاح دائماً.
- عرض freshness timestamp وstale/error/unsupported discovery.
- saved model الغائب يبقى ظاهراً ومختاراً مع شارة.
- refresh لا يغير اختيار المستخدم تلقائياً.
- capability supported/unknown مع لغة واضحة، لا تجعل unknown failure.
- Test selected model فعل صريح مع تنبيه تكلفة صغيرة.

Frontend — Chat/Embeddings:
- selectors مستقلة.
- نموذج embeddings يعرض requirement 1536 ونتيجة observed dimensions.
- تغيير الإعداد يعرض re-index impact وحالته.
- تعطيل semantic لا يعطل Chat أو lexical knowledge search.
- حافظ على system prompt/auto-reply/handoff UX الحالي.

i18n/accessibility:
- حدث كل locale موجود في الفرع ولا تكتب نصوص JSX ثابتة.
- labels/help/errors/statuses مترجمة.
- keyboard navigation، focus management، aria/live status، وعدم الاعتماد على اللون وحده.

الاختبارات الإلزامية:
- embed adapters ordering/malformed/non-finite/dimension 1536 vs mismatch.
- no DB/RPC write on mismatch.
- revision change وactivation/fallback وعدم mix.
- backfill account with separate embeddings key.
- API ownership وsafe DTOs.
- UI: masked key, fixed/custom root, empty/stale/manual/saved-missing catalogs.
- Chat وEmbeddings من اتصالين مختلفين.
- refresh/error يحافظ على model.
- i18n keys لكل locales وaccessibility الأساسية.
- OpenAI/Anthropic draft/auto-reply وknowledge regression.

لا تفعل:
- لا تغير vector column إلى dimension أخرى في المكان.
- لا تفعّل أي نموذج بناء على الاسم فقط.
- لا تجلب models عند كل render.
- لا تمسح المفتاح عند field فارغ.
- لا تحذف القديم أو تبدأ contract phase.

شغّل التحقق الكامل والبناء. اكتب phase-05-embeddings-ux.md وفق القالب، وضمنه مخطط revision/re-index، counts/rollback، screenshots أو وصف حالات UI وفق أدوات المشروع، ونتائج كل اختبار. توقف ولا تبدأ المرحلة 06.
```

## بوابة القبول

- لا vector مخالف يصل إلى قاعدة البيانات.
- تغيير embedding config له مسار re-index صريح وآمن.
- UI يحتفظ بالاختيار ويتيح manual entry.
- كل الأسرار تبقى server-side وكل locales محدثة.

# برومبت المرحلة 06 — التقسية والتوثيق والإطلاق

``` text
نفّذ المرحلة 06 فقط بعد قبول جميع المراحل الوظيفية. لا تضف مزوّداً أو ميزة جديدة. الهدف إغلاق فجوات الأمن والانحدار وتجربة migration/rollback وإعداد release تدريجي موثق.

1) مراجعة النطاق والدين
- اجمع تقارير 00–05 وADRs والانحرافات/TODOs.
- اربط كل معيار قبول في الوثيقة الرئيسية باختبار أو دليل.
- صنف المتبقي: blocker، follow-up، أو deliberate non-goal. لا تترك TODO أمني بلا owner.

2) اختبار شامل
- شغّل unit/contract/integration/RLS/API/UI/full regression.
- شغّل format:check، lint، typecheck، test، production build بالأوامر الفعلية.
- اختبر limits: pages/models/bytes/time/concurrency/rate.
- نفّذ migration/backfill على fixture قديمة مرتين، ثم جرب feature-flag rollback.
- اختبر OpenAI/Anthropic القديم، OpenAI-compatible fixture، Gemini Native fixture، manual model، stale cache، separate embeddings.
- لا تستخدم مفاتيح حقيقية في CI. live smoke اختياري وبموافقة وبيئة منفصلة فقط.

3) Security review
- threat model محدث طبقاً للكود النهائي.
- ابحث عن كل fetch للمزوّد وتأكد أنه يمر بالسياسة المطلوبة.
- راجع SSRF IPv4/IPv6/DNS/redirect/private opt-in وegress assumptions.
- راجع responses/logs/errors/DOM/telemetry لمنع الأسرار ومحتوى العملاء.
- راجع RLS وSECURITY DEFINER وcross-account.
- راجع dependencies الجديدة وسببها.
- راجع retry؛ generation call count واحد افتراضياً.

4) Reliability/observability
- structured safe events وrequest IDs والـ metrics المحددة.
- alerts/queries أو تعليمات مراقبة للفشل، 401/429/timeouts، discovery stale، migration fallback، dimension mismatch.
- لا prompts أو provider bodies في telemetry.

5) وثائق التسليم داخل المستودع
- Architecture/provider adapter contract.
- Admin guide لإنشاء اتصال واكتشاف/إدخال نموذج واختباره.
- Self-hosted guide للـ custom/private endpoints و9Router مع defaults آمنة.
- Add-a-provider/preset guide.
- Embedding/re-index guide.
- Migration/backfill/rollback runbook.
- Env example بلا أسرار.
- Release notes وknown limitations.
- تحديث كل docs قديمة تقول OpenAI/Anthropic فقط.

6) خطة الإطلاق
- feature flags افتراضياً off للميزات الجديدة إن كان ذلك ممكناً.
- canary account/staging، ثم دفعات.
- pre/post counts ومؤشرات نجاح وفشل.
- rollback trigger واضح ومالك القرار.
- إبقاء schema/columns القديمة خلال نافذة الرجوع.
- حدد تاريخاً/شرطاً ومالكاً لـ contract phase اللاحقة، ولا تنفذها الآن.

المخرج:
- أصلح فقط الأخطاء الموجودة ضمن النطاق، وأضف الاختبارات/الوثائق اللازمة.
- اكتب phase-06-hardening-release.md وفق القالب.
- أنشئ final traceability table: requirement → implementation → test → doc.
- أعط release recommendation واحدة: READY، READY WITH NAMED CONDITIONS، أو NOT READY، مع أدلة.

قيود:
- لا deploy/push/commit/production migration بلا تفويض صريح.
- لا تصف build/test غير المشغل بأنه ناجح.
- لا تحذف legacy columns أو secrets في هذه المرحلة.
- إذا بقيت ثغرة SSRF أو secret leak أو data migration blocker، النتيجة NOT READY.

توقف بعد تقرير الجاهزية وانتظر قرار الإطلاق البشري.
```

## بوابة القبول

- Traceability كاملة.
- rollback مجرب، لا موصوف نظرياً فقط.
- لا blocker أمني أو سلامة بيانات مفتوح.
- release recommendation مدعومة بنتائج أوامر واختبارات واضحة.

# قالب تقرير مرحلة

> يُنسخ هذا القالب لكل مرحلة تحت `docs/implementation/ai-multi-provider/`، ويستبدل النص الإرشادي بأدلة فعلية.

## 1. Metadata

| الحقل            | القيمة                         |
|------------------|--------------------------------|
| المرحلة          | `XX — name`                    |
| التاريخ          | ISO date                       |
| الفرع            | branch                         |
| الالتزام الأساسي | commit SHA                     |
| الالتزام الحالي  | commit SHA أو `uncommitted`    |
| المنفذ/المراجع   | names or agents                |
| الحالة           | GO / STOP / PASS / CONDITIONAL |

## 2. الهدف والنطاق

- الهدف المتفق عليه:
- ما نُفذ:
- ما لم يُنفذ عمداً:
- أي انحراف:

## 3. ملخص النتيجة

فقرة قصيرة تقود بالنتيجة، لا بسرد الخطوات.

## 4. القرارات

| القرار | السبب | ADR/مرجع | الأثر |
|--------|-------|----------|-------|

## 5. الملفات

| الملف | Added/Modified/Deleted | الغرض |
|-------|------------------------|-------|

أكد أن أي ملف معدل مسبقاً من المستخدم حُفظ ولم يُكتب فوقه.

## 6. تدفق قبل/بعد

استخدم Mermaid صغيراً أو وصفاً واضحاً إن تغيرت العلاقات. لا تضف رسماً لا يوضح علاقة مهمة.

## 7. البيانات والترحيل

- migrations:
- forward behavior:
- backfill/idempotency:
- legacy compatibility:
- rollback:
- counts/verification:
- production migration run: **No** ما لم يوجد تفويض موثق.

اكتب `N/A` مع السبب إذا لم تمس المرحلة البيانات.

## 8. الأمن والخصوصية

- secrets handling:
- authorization/RLS:
- outbound/SSRF:
- redaction/logging:
- rate/time/size limits:
- findings المتبقية:

## 9. الاختبارات

| الاختبار/الملف | السيناريو | النتيجة |
|----------------|-----------|---------|

### نتائج الأوامر

| الأمر الفعلي | Exit code | النتيجة/الملاحظات |
|--------------|----------:|-------------------|
| `...`        |    0/غيره | ...               |

لا تكتب `passed` لأمر لم يُشغّل. استخدم `Not run` وسبباً قابلاً للتحقق.

## 10. معايير القبول

- [ ] Criterion 1 — evidence/link
- [ ] Criterion 2 — evidence/link

## 11. المخاطر والقيود

| الخطر/القيد | الاحتمال | الأثر | التخفيف | المالك |
|-------------|----------|-------|---------|--------|

## 12. الرجوع

خطوات محددة لإبطال سلوك المرحلة مع المحافظة على البيانات. ميّز بين code rollback وschema rollback وfeature flag. لا تقترح drop/destructive rollback تلقائياً.

## 13. الأسئلة والمتابعة

- Blockers:
- Follow-ups خارج النطاق:
- Debt له owner/date:

## 14. توصية الانتقال

`GO` أو `STOP` مع سبب ودليل مختصر. لا تبدأ المرحلة التالية داخل التقرير.

# ADR-NNN: عنوان القرار

**الحالة:** Proposed / Accepted / Superseded / Rejected  
**التاريخ:** YYYY-MM-DD  
**أصحاب القرار:** ...  
**يحل محل/يحل محله:** ...

## السياق

صف المشكلة والقيود الحالية والأدلة. اربط بمسارات/اختبارات/وثائق، ولا تفترض أن اسم المزوّد يساوي البروتوكول.

## قوى القرار

- الأمان والخصوصية.
- التوافق الخلفي وسلامة البيانات.
- قابلية التشغيل والرجوع.
- القابلية للصيانة والتوسع.
- زمن/تعقيد التنفيذ.

احذف أو أضف ما يلزم.

## الخيارات

### الخيار A

- الوصف:
- الإيجابيات:
- السلبيات:
- مخاطر/تكلفة الترحيل:

### الخيار B

- الوصف:
- الإيجابيات:
- السلبيات:
- مخاطر/تكلفة الترحيل:

## القرار

اذكر ما اختير بعبارة قابلة للاختبار، وما ليس جزءاً منه.

## النتائج

### إيجابية

- ...

### سلبية/مقايضات

- ...

### مخاطر وتخفيف

- ...

## خطة التنفيذ والترحيل

- الترتيب:
- feature flag:
- backfill:
- rollback:
- contract/cleanup لاحقاً:

## أدلة القبول

- الاختبارات:
- القياسات:
- وثائق التشغيل:

## شروط إعادة النظر

حدد الحدث أو الدليل الذي يبرر فتح القرار، مثل حاجة فعلية لأبعاد متعددة أو دعم idempotency رسمي.

## المراجع

- روابط رسمية أو ملفات داخلية.
