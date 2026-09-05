# برومبت المرحلة 00 — الاستكشاف وخطة التنفيذ

انسخ هذا البرومبت إلى وكيل البرمجة وهو داخل مستودع WACRM. لا تستخدمه بعد أن بدأ الوكيل تعديلات غير مراجعة؛ اجعله أول خطوة.

```text
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

