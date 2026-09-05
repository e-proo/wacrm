# برومبت المرحلة 06 — التقسية والتوثيق والإطلاق

```text
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

