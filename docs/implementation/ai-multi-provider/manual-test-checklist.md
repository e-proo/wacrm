# Manual Test Checklist — Multi-Provider (Phases 02–05)

جرّب الإعدادات الجديدة يدويًا باتباع هذا التسلسل على بيئة التطوير (staging أو local DB).

---

## 0) التجهيز

```powershell
# 1) طبق الـ migrations الثلاثة (040/041/042) بنفس أسلوبك المعتاد:
npx supabase db push

# 2) فعّل الأعلام في .env.local (مؤقتًا للتجربة):
#    AI_MULTI_PROVIDER_ENABLED=true
#    CONNECTION_FINGERPRINT_SALT=أي-نص-عشوائي-طويل
# (الأعلام الخاصة بالنقاط المخصصة اتركها false الآن)

# 3) شغّل:
npm run dev
```

سجّل دخولك كـ **owner/admin** ثم افتح: الإعدادات → مساعد الذكاء الاصطناعي (Agent setup).

---

## 1) الفحص السريع (بدون اتصال provider حقيقي)

| # | الخطوة | النتيجة المتوقعة |
|---|---|---|
| 1.1 | افتح الإعدادات مع `AI_MULTI_PROVIDER_ENABLED=false` | **لا يظهر** أي شيء جديد — نفس الشاشة القديمة 100% (اختبار التراجع) |
| 1.2 | شغّل العلم `true` وحدث الصفحة | تظهر بطاقات جديدة: **Provider connections** + **Chat & Embeddings connections** |
| 1.3 | في DevTools → Network: `GET /api/ai/connections` | `200` وقائمة فارغة؛ **ابحث في النص عن `api_key` أو `encrypted` أو `auth` — يجب أن تكون غائبة تمامًا** |

## 2) إنشاء اتصال والتحقق (تحتاج مفتاح OpenAI أو Gemini صالحًا)

| # | الخطوة | النتيجة المتوقعة |
|---|---|---|
| 2.1 | Add connection → اختر **OpenAI** أو **Gemini** أو **DeepSeek** → أدخل اسمًا ومفتاحًا → Save | نجاح؛ الصف يظهر مع شارة "Unverified"، والجذر (root) **معروض read-only** لا يعدَّل |
| 2.2 | اضغط **Verify & load models** | Badge → Verified؛ المنسدلة/الحقل يمتلئ بالنماذج؛ رسالة "Catalog updated at …" |
| 2.3 | أعد حفظ النموذج **بدون تغيير شيء** | المفتاح **لا يعاد إرساله** (في Network: لا يوجد `api_key`) والكاش يبقى |
| 2.4 | عدّل الاتصال واترك حقل المفتاح فارغًا → Save | المفتاح القديم سليم (جرّب Verify مرة أخرى → ينجح) |
| 2.5 | ضع مفتاحًا خاطئًا → Test selected model | رسالة آمنة برمز خطأ عام بدون أي تفصيل من جسم مزوّد الخدمة |
| 2.6 | اختر OpenAI وأدخل Model يدويًا (بدون Refresh) → Test | يعمل — الاكتشاف اختياري (ADR-004)، والإدخال اليدوي موازٍ وليس احتياطيًا |
| 2.7 | احذف اتصالًا مستخدمًا من الإعداد | **409** والرسالة: بدّل الاختيار أولًا |

## 3) Chat عبر اتصال مختلف

1. في **Chat & Embeddings connections** اختر اتصال Gemini ( أو أي اتصال) + موديل.
2. Save.
3. افتح Inbox → محادثة → زر "Draft with AI".
4. المتوقع: الرد يولَّد عبر Gemini. تأكد في الشبكة أن الطلب ذهب للسيرفر ولم يظهر أي مفتاح.
5. **Regression إلزامي:** نفس الاختبار مع حساب لم يربط اتصالًا (المسار القديم openai/anthropic) يجب أن يعمل كما كان بالضبط، والـ PlayGround والأمر `/api/ai/test` القديم أيضًا.

## 4) المعرفة: التضمينات وإعادة الفهرسة (قلب المرحلة 05)

> القاعدة: الفهرس الحالي يقبل **1536 فقط** أي مودیل ينتج غير ذلك يجب أن يُرفض **قبل الكتابة**.

| # | الخطوة | النتيجة المتوقعة |
|---|---|---|
| 4.1 | اربط اتصال **Embeddings = OpenAI + model `text-embedding-3-small`** → Save | شارة الحالة تتحول **Pending** مع رسالة تأثير إعادة الفهرسة (المعرفة الحالية ما زالت تعمل بالمفتاح القديم/الكلمات المفتاحية) |
| 4.2 | من بطاقة Knowledge base اضغط **Reindex** | `state: ready` في الرد؛ الشارة تتحول **Semantic index active** |
| 4.3 | أضف مستندًا جديدًا ثم بحث في Inbox بعبارة من معناه | نتيجة تظهر عبر الدلالات. في **SQL** تأكد: `select embedding_revision, count(*) from ai_knowledge_chunks group by 1;` — الصفوف الجديدة تحمل نفس التوكن `rev_…` |
| 4.4 | **اختبار الرفض:** غيّر Embeddings model إلى `gemini-embedding-001` أو أي ناتجه ≠1536 → احفظ → Reindex | يفشل بـ `AI_EMBEDDING_DIMENSION_MISMATCH`؛ **الحالة failed**؛ الدلالات القديمة أو fallback النصي **يستمران بالعمل**؛ لا صفّ vectors جديدة ملوَّثة (راجع SQL: لا توجد صفوف بالتوكن الجديد الناقص) |
| 4.5 | أزل تهيئة الاتصال (No connection) | يعود الوضع للمفتاح القديم أو للنص فقط — **الجوابات (chat) لا تتأثر أبدًا** والفهرس القديم لم يُحذف |
| 4.6 | مع العلم مطفأ تمامًا: كرر رفع مستند وبحث | نفس سلوك ما قبل المشروع تمامًا |

## 4b) حساب الاستخدام مع اتصال خارجي (044) — **يتطلب `npx supabase db push` أولًا**

| # | الخطوة | النتيجة المتوقعة |
|---|---|---|
| 4b.1 | افتح تبويب Usage — الحالة قبل أي استدعاء | «No AI usage…» طبيعي إذا كان كل شيء نظيفًا |
| 4b.2 | شغّل رسالتين في Playground عبر اتصال b.ai (أو أي اتصال) | عُد للتبويب: **LLM calls = 2**؛ إن كان البوابة لا ترسل usage تظهر ملاحظة «calls came through a gateway that does not report…»، والإحصاء يبقى صحيحًا |
| 4b.3 | فعّل «Enable AI» واستخدم Draft في inbox عبر نفس الاتصال | يضاف لدلو draft مع التوكنات (إن رُسلت) |
| 4b.4 | **SQL للتأكيد:** `select mode, provider, model, total_tokens, usage_reported, connection_id from ai_usage_log order by created_at desc limit 5;` | صف لكل استدعاء؛ `connection_id` = اتصالك الخارجي؛ `usage_reported=false` مسموح فقط إن كانت البوابة لا تُبلّغ |
| 4b.5 | بدّل المزوّد (مثلاً أُنشئ اتصال Gemini) وجرّب Playground | التبويب يحسبه أيضًا دون أي تغيير إعدادات — التجميع لا يعرف اسم أي مزوّد |

## 5) اللغات والنفاذية (i18n + A11y)

- بدّل ar / en / ko: كل النصوص الجديدة مترجمة (اختبار `messages.test.ts` يضمن التكافؤ؛ أي مفتاح ناقص يُفشل CI).
- في ar: الـ dialog والجداول تنعكس RTL بشكل سليم.
- Tab عبر نموذج الإنشاء: كل حقل له label، وأزرار الحالة تُعلن عبر aria-live (مع قارئ شاشة: تسمع نجاح/فشل التحقق).
- ألوان Badges وحدها لا تحمل المعنى: كل شارة لها نص.

## 6) أمان — نقاط تفحص يدويًا

1. Network/Responses: لا يوجد في أي مكان `Bearer `، `x-api-key`، `sk-`، `AIza`، `encrypted_api_key`.
2. سجلّات السيرفر: لا مفاتيح ولا نصوص محادثات في console.output (الرسائل رموز عامة فقط).
3. اتصال مخصص (`api_root` مختلف): لا يظهر أساسًا في القائمة حتى تفعّل `AI_CUSTOM_ENDPOINTS_ENABLED=true` وتضيف `AI_ENDPOINT_ALLOWLIST` — عند الإطفاء أي محاولة POST بجذر مخصص تُرفض.
4. `CONNECTION_FINGERPRINT_SALT` غيّرته ثم أعد التشغيل: لن تتغير دالة fingerprints المستخدمة للكاش (قيمة مخزنة)، لكن الحسابات الجديدة ستختلف — لا ضرر سلوكي.

## 7) الاختبارات المؤتمتة (تشغيلها قبل أي قبول)

```powershell
npx vitest run           # 944/944
npm run typecheck
npm run lint             # 0 errors / 36 warnings baseline
npm run build            # exit 0
# اختبار بوابة المرحلة 05 تحديدًا:
npx vitest run src/lib/ai/connections/embed.test.ts src/lib/ai/knowledge.test.ts src/lib/ai/connections/backfill.test.ts
```

## 8) رجوع سريع (لو شيء تعطّل)

```powershell
# أطفئ العلم في .env.local:
# AI_MULTI_PROVIDER_ENABLED=false
npm run dev
```
يعود كل شيء للسلوك القديم فورًا؛ الجداول والأعمدة الجديدة تُترك دون استخدام (آمنة).

---

### ملاحظات صريحة (لا تتوقع منها عملًا الآن)
- حماية SSRF الكاملة للمضات تعمل على الجذور المخزنة التي ينشئها preset ثابت؛ الغلاف `sendOutbound` يُربط بالإنتاج في المرحلة 06.
- الـ migrations لم تُنفَّذ على قاعدة حية من قبل الوكيل — تنفيذ `040→042` على staging هو البند البشري المطلوب قبل تفعيل الإنتاج.
- DeepSeek/Gemini endpoints وُثقت من الوثائق وقت التطوير؛ أعد مقارنتها بالسيت الرسمي عند الإصدار (بند بشري مسجل في تقارير 03/04).
