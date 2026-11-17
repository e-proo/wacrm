# WACRM — حزمة القبول الحي الموحّدة (TEST فقط)

**المهام:** SOF-66 (تعدد المستهدفين) · SOF-23 / Phase 18 (التشغيل التجريبي والتراجع) · SOF-24 / Phase 19 (Coverage Sourcing Pilot)  
**تاريخ إعداد الحزمة:** 17 نوفمبر 2026  
**الفرع المرجعي:** `refactor/service-platform-v2`  
**HEAD وقت التدقيق:** `779c7910677049dd5a62394440861a1e9051c513`  
**CI:** https://github.com/e-proo/wacrm/actions/runs/44005517505 — `completed/success`، 2259 اختبارًا ناجحًا  
**Migrations:** https://github.com/e-proo/wacrm/actions/runs/44000513145 — `completed/success` على آخر commit مرتبط بتغييرات الـschema، بما فيه اختبارات Tenant/RLS والتكرار والاستعادة  
**قاعدة TEST:** `pqirsnfupofhulmewakq`  
**حالة TEST عند الإعداد:** Agent Task Cutover = `pilot`، `ready=true`، 0 مهام غير منتهية، 0 رسائل `sending`، 0 رسائل `requires_reconciliation`، إعداد `task_worker_enabled=true`. هذه لقطة زمنية ويجب إعادة فحصها قبل أي تجربة.

> **حدود التفويض:** هذه وثيقة خطة/حزمة اختبار، وليست تفويضًا لإرسال رسائل جديدة أو إيقاف Pilot. التنفيذ الحي يتم من قِبل مشغّل TEST بعد مراجعة موافقة كل رقم. لا تغيّر Production أو مواعيد الاستحقاق أو تعيد محاولة رسالة ذات نتيجة ملتبسة. لا تعدّل migrations مطبقة.

## أ. أدلة ناجحة موجودة — لا تُكررها بلا داعٍ

| الدليل | الوضع |
|---|---|
| مهمة `14fcc0ca-a18b-4999-9f7e-4b85326796f0` | `completed` آليًا، بتاريخ 2026-11-17 02:34:04 UTC |
| نفس المهمة تستهدف جهتين محددتين على OpenWA واحد | 2 Target بحالة `completed` |
| حجز إرسال أول واحد لكل جهة | 2 Reservation، كل منها `sent`، وكل منها بمحاولة/مفتاح Idempotency مستقل ومعرّف رسالة لدى المزود |
| محادثتان وردان صحيحان | 2 Inbound Runs ناجحة، كل رسالة على الـConversation والـTarget الصحيح |
| دورة الموافقة والأعمال | CHG-31 + CHG-32 بحالة `executed`، عرضان منفصلان بمبلغ 300 SAR لكل منهما وعمولة 7/1000، وحدثا أعمال `coverage.offer.approved` بحالة `sent` |
| جهة جديدة دون سجل عروض سابق | نجح الاستهداف الصريح؛ تاريخ عروض المورد مجرد توصية لا مانع |
| حالة الطلب المالي | 550 SAR مطلوب؛ 0 محجوز و0 منفّذ؛ **لا** تمثل عروض 600 SAR حجزًا ماليًا |

دليل GitHub الأصلي: [19_SOF66_TWO_TARGET_LIVE_TEST_CHECKPOINT.md](https://github.com/e-proo/wacrm/blob/refactor/service-platform-v2/plans/%D8%AA%D8%B9%D8%AF%D8%AF%20%D8%A7%D9%84%D9%88%D9%83%D9%84%D8%A7%D8%A1%20%D9%88%D9%82%D8%B3%D9%85%20%D8%A7%D9%84%D8%AE%D8%AF%D9%85%D8%A7%D8%AA/19_SOF66_TWO_TARGET_LIVE_TEST_CHECKPOINT.md).

## ب. تعليمات الحماية قبل التشغيل — إلزامية

- [ ] أوقف نسخة `npm run dev` القديمة. من مسار مشروع Windows الصحيح نفذ: `git switch refactor/service-platform-v2` ثم `git pull --ff-only origin refactor/service-platform-v2` ثم `npm run dev`. تحقق من HEAD مرة أخرى؛ لا تغيّر الفرع إلى main.
- [ ] تأكد أن تطبيقك يشير فقط إلى Supabase TEST `pqirsnfupofhulmewakq`، وأن حساب TEST الصحيح مفتوح، ولا توجد مهام سابقة `queued/running` قابلة لإرسال مفاجئ. راجع زر **فحص المهام الآن**.
- [ ] من **الوكلاء → مهام الوكلاء → عامل المهام** اضغط **إيقاف العامل**، ثم **فحص المهام الآن**. هذا يوقف بدء الأعمال الجديدة للحساب ولا يُلغي إرسالًا بدأ فعلًا. لا تعتمد على توقف مؤقت في صفحة المتصفح.
- [ ] من **بوابة إرسال مهام الوكلاء — TEST فقط** اضغط **فحص الجاهزية** وسجّل: `mode`, `ready`, `blockers`, `sendingMessages`, `reconciliationMessages`, `nonterminalTasks`. يجب عدم وجود عمليات إرسال جارية أو رسالة تتطلب مصالحة قبل الانتقال.
- [ ] سجّل حالة OpenWA للجلسة المختارة، وأنها `ready` وغير مؤرشفة، وسجّل `pilot_enabled`, `paused`, `active_admissions`, الحد الساعي/اليومي، وحدود Workload. لا تغيّر رابط الجلسة أو مفتاحها أثناء الاختبار.
- [ ] اختر **2–3 أرقام TEST تملكها أو حصلت من أصحابها على موافقة صريحة على رسائل واتساب لهذا الاختبار**. يجب أن تكون في حساب CRM نفسه، ليست جهة صاحب الطلب، ولا يوجد Opt-out أو حظر. توثيق مكالمة هاتفية مُصرّح بها إلى واتساب صالح لمسار TEST المخصص فقط؛ لا تفترض أن مكالمة مجردة تكفي.
- [ ] استخدم **Coverage Request اختبار جديدًا ونشطًا** مع اتجاه/منطقتين واضحتين لتجنب الخلط مع العرضين السابقين (600 SAR مقابل 550 SAR). لا تحذف أو تعدل عروض CHG-31/CHG-32 ولا تعيد إرسال المهمة المنتهية.
- [ ] راجع الـPublished Agent Revision: `coverage.sourcing@2`، وقدرة `maxTargets` مناسبة، وأداة الاقتراح مقيدة بالمقترح فقط. اضبط `maxAttemptsPerTarget=1`، وامنع Follow-up تلقائيًا حيث تسمح إعدادات Builder؛ الردود التفاعلية تحتاج سعة مستقلة في Pilot.
- [ ] في **الإعدادات → WhatsApp → جلسة OpenWA المختارة → OpenWA Agent Pilot**: اعتمد الأرقام نفسها تحت Workload = `agent` مع consent مناسب. أدخل `messages_per_recipient` محافظًا لكنه كافٍ للردود (مثلاً 3–4 حسب السيناريو) واحسب سعة الجلسة `عدد الجهات × الرسائل لكل جهة`، وراجع حدود الحساب والوكيل والجلسة وحد أول تواصل. استخدم زر **تجهيز حدود الوكيل لـ N أرقام** كاقتراح فقط ثم احفظ الحدود صراحةً. إذا أوقفت Pilot لإعادة التهيئة فهذا يسحب الموافقات القديمة: أعدها للمجموعة المقصودة فقط. لا تعتمد رقمًا آخر ضمن المجموعة عن طريق الخطأ. تحقق من التواريخ والصلاحية ثم ابدأ جلسة Pilot صراحةً.
- [ ] يجب أن تكون بوابة `Agent Task Cutover` في `pilot` للسماح بإنشاء Task من واجهة هذه النسخة؛ **اترك العامل موقوفًا أثناء الإنشاء** كي لا تبدأ الإرسالات تلقائيًا. إذا كانت البوابة `disabled`، فعّلها فقط عند جاهزية TEST الصريحة وبعد تثبيت إيقاف العامل ومراجعة الأطراف.

### ترتيب التحكم في الأزرار (لا تخلط بينها)

| الزر | ماذا يفعل فعليًا؟ |
|---|---|
| **إيقاف العامل** | يمنع Claim جديدًا لهذا الحساب؛ قد تستقر رسالة بدأت مسبقًا |
| **إيقاف مؤقت** في مهمة بعينها | يوقف تقدم المهمة نفسها مع الحفاظ على سجلها |
| **إيقاف إرسال Agent Task** | يغيّر بوابة إرسال المهام والحصة المقابلة في قناة WhatsApp إلى `disabled` بصورة ذرية؛ لا يلغي رسالة قبلها المزود |
| **Stop** في OpenWA Agent Pilot | إجراء مستقل لبوابة الجلسة؛ قد يسحب موافقات عدة جهات ويؤثر في Workloads أخرى، لذا افحصها قبل الضغط |
| **Take over** في Inbox | يوقف Auto-Reply ويُسند المحادثة إلى الموظف؛ **قد لا يكون وحده دليلاً** على إيقاف Task Target أو انتقاله إلى `paused_for_human` |

## ج. حالات الاختبار الحي المطلوبة (بترتيبها)

| الرمز | الفحص | الإجراء العملي | شرط النجاح | التذكرة |
|---|---|---|---|---|
| **AC-01** | إنشاء دفعة مضبوطة | والعامل **موقوف**، أنشئ `coverage.sourcing@2` بمستهدفين/ثلاثة محددين وجلسة OpenWA محددة | Task واحد، قائمة مستهدفين مطابقة تمامًا، `maxAttemptsPerTarget=1`، لا رسالة مرسلة قبل تشغيل العامل | SOF-66 / SOF-23 |
| **AC-02** | Pause قبل الإرسال | اضغط **إيقاف مؤقت** على Task الجديدة؛ بعدها شغّل العامل وانتظر دورتين على الأقل (15 ثانية تقريبًا للدورة) مع مراقبة الواجهة | Task = `paused`، لا Outbound جديد، ولا استهلاك محاولة، ولا تبديل للمستهدف | SOF-66 / SOF-23 |
| **AC-03** | Resume وإرسال مضبوط | اضغط **استئناف المهمة**؛ راقب `حالة كل رقم` و`تحديث حالة الأرقام` والرسائل | لكل جهة مستحقة بالضبط رسالة أولية واحدة على الجلسة الصحيحة، مع Provider ID، وتستقر الرسالة؛ لا توسع تلقائي للمجموعة | SOF-66 / SOF-23 |
| **AC-04** | إعادة تشغيل العامل | بعد استقرار الرسائل المرسلة (لا `sending/reconciliation`)، أوقف العامل وأعد تشغيل Next.js، ثم افحص وبعدها شغّل العامل؛ **لا** تقطع العملية لحظة إرسال حقيقي | نفس Task/Target/Run/Reservation IDs بلا تكرار، والردود الواردة لاحقًا تعمل | SOF-66 / SOF-23 |
| **AC-05** | ردود متزامنة ومختلفة | من رقمين مختلفين أرسل ردًا في كل محادثة (دون تضمين أسرار أو أرقام حقيقية في الأدلة المنشورة) | كل Inbound مرتبط بنفس `conversation_id/contact_id/task_target_id` الصحيح، بدون تسرب أو إعادة توجيه خاطئ | SOF-66 / SOF-24 |
| **AC-06** | رفض واضح | يرد أحد الموردين **«لا أستطيع توفير التغطية»** في تجربة جديدة | يسجل الرفض بوصفه Outcome/Target terminal مناسب؛ **لا** ينشئ `coverage.offer.create` ولا يزوّر اكتمال Offer | SOF-24 |
| **AC-07** | عرض بمسار مختلف | يرد مورد آخر بعرض واضح بمبلغ/عمولة و**مكان استلام مختلف صراحةً** عن مسار الطلب؛ يوافق على رفعه للمراجعة | إنشاء `coverage.supplier_counteroffer.review` للمراجعة الإدارية **فقط**؛ لا ينشئ Coverage Offer مطابقًا تلقائيًا ولا يغيّر مصدر الطلب | SOF-24 |
| **AC-08** | تسليم بشري حقيقي | افتح محادثة المورد من Inbox واضغط Take over عند ظهور الأداة، أو استخدم مسار المراجعة البشرية المدعوم. افحص التعيين للموظف **ومنع استمرار إرسال Task** | الموظف استلم المحادثة. بالإضافة لذلك يجب إثبات حالة Task Target/guardrail التي تمنع الوكيل من إرسال جديد؛ إذا لم تتصل حالتا Inbox وTask فهذا **blocker** لا نجاح افتراضي | SOF-24 |
| **AC-09** | Opt-out ومنع الإرسال | برقم اختبار مملوك ومصرّح به اختبر STOP/انسحاب في محادثة جديدة مناسبة، دون إعادة استخدام رقم حقيقي بعد إلغاء موافقته | تسجيل Opt-out وحظر الإرسالات اللاحقة، وعدم استبدال رقم مستبعد بجهة أخرى | SOF-66 / SOF-24 |
| **AC-10** | Replay / idempotency | راجع اختبارات CI الموجودة، ثم أجرِ إعادة معالجة **آمنة لمحتوى Webhook تجريبي مخول** فقط إن توفرت أداة replay مضمونة. لا تستدعِ Send API ولا تُولّد إرسالًا مزودًا جديدًا بغرض الاختبار | لا تتكرر الرسالة أو Run أو Reservation أو العرض بعد إعادة معالجة نفس الحدث. أي `ambiguous_outcome` يتطلب reconciliation لا إعادة إرسال | SOF-66 / SOF-23 |
| **AC-11** | نهاية صحيحة دون اصطناع | أنهِ مهمة السيناريو السلبي حسب سياسة النظام: `partially_completed` إذا جميع المستهدفين رفضوا/استُنفدوا أو تم التعامل البشري ولا عروض معتمدة؛ لا تضغط **إنهاء كمكتملة** لتجاوز النتيجة | حالة المهمة وReason وOutcome مطابقة للحقيقة؛ لا إنشاء عرض مالي بلا موافقة | SOF-24 |
| **AC-12** | Rollback بعد الدفعة | بعد المصالحة، اضغط **إيقاف إرسال Agent Task** ثم **إيقاف العامل**، وافحص بوابة CUTOVER | `mode=disabled` و`outbound_task_delivery_enabled=false` و`whatsapp scope enabled=false`، ولا عمليات `sending/reconciliation` أو إرسال جديد | SOF-66 / SOF-23 |
| **AC-13** | Inbound بعد Rollback | من أحد أرقام TEST أرسل رسالة واتساب واردة عادية بعد إيقاف إرسال المهام | تصل إلى CRM، دون إعادة تنشيط Task السابقة، ودون إنشاء إرسال Task جديد | SOF-66 / SOF-23 |

**اقتصاد التجربة:** يمكن اختبار AC-01 إلى AC-08 في مهمة TEST جديدة واحدة بـ2–3 جهات، لكن لا تؤدِّ محادثة بشرية أو انسحابًا إلى إبطال إمكانية اختبار الرفض. عند تعارض الحالات، استخدم Task TEST أخرى مستقلة وبأرقام لها موافقة، بعد مراجعة cooldown والحدود. لا تُعِد استخدام Task مغلقة أو تكرر رسالة غامضة. تستغني AC-10 عن إرسال مزود جديد إذا أُثبتت عبر CI + replay آمن حقيقي؛ وإلا تُسجّل «لم تُختبر حيًا» ويبقى Gate المعني مفتوحًا.

### ملاحظات خاصة بالعروض البديلة وHuman Takeover

- مثال توضيحي **مشروط باتجاه الطلب الفعلي**: «أستطيع توفير 200 ريال بعمولة 7 لكل 1000، لكن **أستلم في عدن بدل صنعاء**؛ أريد عرض ذلك على الإدارة». استخدم أسماء مناطق صحيحة مختلفة عن المسار المجمد لتجنب عرض مطابق بالخطأ. إذا طلب الوكيل تفاصيل أخرى، استكملها طبيعيًا؛ لا تتوقع قبول هذه العبارة وحدها مسبقًا.
- قبول الإدارة **لمراجعة بديل** لا يعني تحويله تلقائيًا إلى Coverage Offer مطابق. راقب `action_key` ودليل عدم وجود `coverage_offers` جديد لنفس Change Request.
- زر Inbox **Take over** يستهدف `conversations.ai_autoreply_disabled` و`assigned_agent_id`؛ يجب التحقق بصورة مستقلة من عدم استمرار عامل مهمة التغطية واستلام الموظف. إذا بقي الـTask Target actionable أو استمرت رسائل الوكيل بعد التسليم، سجّل خللًا ولا تغلق Phase 19.
- التكرار المطلوب اختباره يشمل الإرسال الأول والعرض وChange Request والـBusiness Event، وليس عدد رسائل الحوار التفاعلية؛ قد يرسل الوكيل أكثر من رد تفاعلي مصرح به دون أن يكون إرسالًا أوليًا مكررًا.

## د. أوامر تشغيل محلية غير مُرسلة

من PowerShell داخل مجلد WACRM:

```powershell
# بعد إيقاف خادم npm run dev القديم:
git switch refactor/service-platform-v2
git pull --ff-only origin refactor/service-platform-v2
git rev-parse HEAD
npm run dev
```

**تحذير:** تشغيل `npm run dev` مع `WACRM_DEV_AGENT_TASK_WORKER=on` يفعّل timer محليًا كل 15 ثانية. أوقف عامل حسابك من الواجهة قبل تشغيل البيئة، أو عيّن `WACRM_DEV_AGENT_TASK_WORKER=off` في `.env.local` وأعِد تشغيل الخادم أثناء التجهيز. إعادة تفعيله تتطلب تغيير الإعداد وإعادة تشغيل الخادم؛ زر تشغيل العامل في UI وحده لا ينشئ Timer إذا كان متوقفًا على مستوى العملية.

## هـ. استعلامات تحقق قراءة فقط على Supabase TEST

تحقق من **حالة بوابة الحساب** (لا يرسل ولا يبدّل الوضع):

```sql
SELECT public.inspect_ai_agent_task_test_cutover_readiness(
  '8ed95309-96cd-4347-b725-bd8c5039ed4f'::uuid
) AS readiness;
```

تحقق من **مهمة جديدة**: استبدل `REPLACE_WITH_NEW_TASK_UUID` بالمعرّف الفعلي بعد إنشائها:

```sql
WITH target_task AS (
  SELECT 'REPLACE_WITH_NEW_TASK_UUID'::uuid AS id,
         '8ed95309-96cd-4347-b725-bd8c5039ed4f'::uuid AS account_id
)
SELECT t.id, t.status, t.manual_closure_kind, t.created_at, t.completed_at,
       count(tt.id) AS targets,
       count(tt.id) FILTER (WHERE tt.status = 'completed') AS completed_targets,
       count(tt.id) FILTER (WHERE tt.status = 'paused_for_human') AS human_targets
FROM ai_agent_tasks t
JOIN target_task x ON x.id=t.id AND x.account_id=t.account_id
LEFT JOIN ai_agent_task_targets tt ON tt.task_id=t.id AND tt.account_id=t.account_id
GROUP BY t.id, t.status, t.manual_closure_kind, t.created_at, t.completed_at;
```

تحقق من **حجوزات الإرسال الأول** وتوقف العمليات الملتبسة:

```sql
WITH target_task AS (
  SELECT 'REPLACE_WITH_NEW_TASK_UUID'::uuid AS id,
         '8ed95309-96cd-4347-b725-bd8c5039ed4f'::uuid AS account_id
)
SELECT o.task_target_id, o.provider, o.connection_id, o.status,
       count(*) AS reservations,
       count(DISTINCT o.idempotency_key) AS distinct_keys,
       count(*) FILTER (WHERE o.whatsapp_message_id IS NULL OR o.whatsapp_message_id = '') AS missing_provider_ids
FROM ai_agent_task_outbound_messages o
JOIN target_task t ON t.id=o.task_id AND t.account_id=o.account_id
GROUP BY o.task_target_id, o.provider, o.connection_id, o.status
ORDER BY o.task_target_id;
```

تحقق من **Trace بدون كشف الرسائل أو أسرار واتساب**:

```sql
SELECT public.inspect_ai_agent_task_trace(
 '8ed95309-96cd-4347-b725-bd8c5039ed4f'::uuid,
 'REPLACE_WITH_NEW_TASK_UUID'::uuid
) AS trace;
```

التحقق من الرسائل الغامضة يجب أن ينظر أيضًا إلى جداول الرسائل وحالة المصالحة على مستوى الاتصال. لا يثبت `status='sent'` وحده أن المستلم قرأ الرسالة.

## و. نموذج تسجيل الأدلة — يُملأ بعد كل اختبار

| الحقل | القيمة |
|---|---|
| تاريخ/توقيت التجربة UTC | … |
| HEAD / CI URL / Migrations URL | … |
| TEST Supabase Project / الحساب | … |
| Task ID / Coverage Request ID / Agent Revision | … |
| Selected Connection ID / provider / ready | … |
| قائمة TEST المستهدفين (معرّفات أو أسماء مستعارة، لا أرقام عامة) | … |
| إقرار WhatsApp consent + Pilot cohort / caps | … |
| وضع العامل وCutover قبل التجربة | … |
| AC-01 إلى AC-13 (PASS/FAIL/BLOCKED مع timestamp) | … |
| Target IDs + Run IDs + reservation provider IDs | … |
| IDs لطلبات الإدارة والنتائج والأحداث | … |
| حالات Opt-out / human handoff وسببها | … |
| أي ambiguous/reconciliation وكيف حُلّت | … |
| بوابة Cutover بعد التجربة (يجب `disabled`) | … |
| post-rollback inbound proof | … |
| ملاحظة ما لم يُختبر حيًا | … |

## ز. قرار إغلاق التذاكر

- **SOF-66 = Done / live TEST acceptance complete** فقط بعد PASS لـ AC-01/02/03/04/05/09/10/12/13، بالإضافة إلى أدلة الاختبارات السلبية account/consent/eligibility في CI. لا تتطلب حصول عطل غامض حقيقي عمدًا؛ إذا لم تتوفر إعادة معالجة حي آمنة، سجّل اعتماد اختبار CI بدقة وحدد إن كان DoD يفرضها حيًا.
- **SOF-23 (Phase 18) = Done / live TEST acceptance complete** بعد نجاح bounded batch + Pause/Resume + worker restart/recovery + crash/ambiguous safe CI evidence + rollback `disabled` + رسالة Inbound بعد rollback، مع إرفاق نتائج SOF-63 السابقة.
- **SOF-24 (Phase 19) = Done / live TEST acceptance complete** فقط إذا أثبت مسار الموردين السابق الصحيح **و** AC-06 رفض حقيقي **و** AC-07 بديل مراجعة فقط **و** AC-08 استلام بشري فعّال **و** AC-11 عدم اصطناع نجاح. لا تغلق بسبب اعتماد CHG-31/32 فقط.
- **Production ready = لا.** `PROJECT_NOTES.md` يحمل `NOTE-001` أمن Supabase العام مفتوحًا؛ تحتاج معالجة مستقلة وإثبات Security Advisor وبيئة التشغيل الإنتاجي، ولا تغير إعدادات Meta Cloud الافتراضية.

## ح. شروط الإيقاف الفوري (STOP)

أوقف إدخال مهام أو إرسال جديد واتبع سجل المصالحة دون إلغاء الرسائل الموجودة إذا ظهر أحد الآتي: اتصال غير مطابق أو جلسة مختلفة؛ Target خارج مجموعة الموافقات؛ موافقة واتساب غير ثابتة أو منتهية؛ رسالة بحالة `sending` عالقة أو `requires_reconciliation`؛ أكثر من إرسال أول لنفس المستهدف؛ تسرب رد لمحادثة أخرى؛ عرض مطابق نتج عن مسار مختلف دون مراجعة؛ إرسال Task بعد handoff/opt-out؛ أي بيانات Production/مستهدف حقيقي غير مصرح به. احفظ الأدلة وأبقِ التذكرة مفتوحة حتى يتم الإصلاح وإعادة التحقق.