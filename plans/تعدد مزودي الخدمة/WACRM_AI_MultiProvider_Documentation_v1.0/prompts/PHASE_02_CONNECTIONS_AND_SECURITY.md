# برومبت المرحلة 02 — Connection entity والأمن والترحيل الإضافي

```text
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

