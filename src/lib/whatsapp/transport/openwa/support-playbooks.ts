/**
 * W07-06 operator support knowledge. Help copy is guidance, NOT an approved
 * WhatsApp/OpenWA usage policy and NEVER an authorization or send action.
 * Every procedure requires a human operator with the required server role.
 */
export type SupportTopic = 'onboarding' | 'governance' | 'delivery' | 'security' | 'operations'
export type SupportSeverity = 'p0' | 'p1' | 'p2' | 'p3'
export type SupportRole = 'owner' | 'admin' | 'support'
export type SupportDestination = 'meta' | 'sessions' | 'pilot' | 'governance' | 'reviews'
export type SupportText = { ar: string; en: string }
export type SupportProcedure = {
  id: string
  topic: SupportTopic
  severity: SupportSeverity
  owner: SupportRole
  title: SupportText
  symptom: SupportText
  steps: readonly SupportText[]
  avoid: SupportText
  escalate: SupportText
  destination: SupportDestination
}
export type SupportGuide = {
  id: string
  topic: SupportTopic
  title: SupportText
  description: SupportText
  steps: readonly SupportText[]
  destination: SupportDestination
}
export type SupportFaq = { id: string; question: SupportText; answer: SupportText; topic: SupportTopic }

const t = (ar: string, en: string): SupportText => ({ ar, en })
const proc = (
  id: string, topic: SupportTopic, severity: SupportSeverity, owner: SupportRole,
  title: SupportText, symptom: SupportText, steps: SupportText[],
  avoid: SupportText, escalate: SupportText, destination: SupportDestination,
): SupportProcedure => ({ id, topic, severity, owner, title, symptom, steps, avoid, escalate, destination })

/** Safe incident playbooks. Containment never silently dispatches, deletes a
 * session, rotates a secret, or changes a recipient/transport. */
export const OPENWA_SUPPORT_PROCEDURES: readonly SupportProcedure[] = [
  proc('session-disconnected','onboarding','p2','admin',
    t('انفصال جلسة OpenWA','OpenWA session disconnected'),
    t('حالة disconnected أو reconnecting وعدم استقرار ربط الجهاز','Session shows disconnected/reconnecting or linked-device instability'),
    [t('حدد الاتصال المتأثر فقط وتأكد من اسم الجلسة وحالتها الحالية.','Identify the exact affected connection and its current state.'),
     t('إذا توجد رسائل مؤتمتة قيد التنفيذ، استخدم الإيقاف الطارئ للجلسة قبل معالجة الاتصال.','If automated sends are pending, use this session’s emergency STOP before recovery.'),
     t('تحقق من إمكانية الوصول إلى Gateway والـwebhook من إعدادات الجلسة دون مشاركة المفاتيح.','Check gateway and webhook reachability in session settings without exposing credentials.'),
     t('استخدم تحديث الحالة ثم إعادة الاتصال للجلسة نفسها عند الحاجة، ولا تنشئ جلسة جديدة لحل المهلة.','Refresh, then reconnect the same session if needed; do not create a new session in response to a timeout.'),
     t('بعد عودة الاتصال، راجع المراجعات والرسائل غير المؤكدة قبل السماح بأي إرسال جديد.','After reconnect, inspect unresolved outbound records before allowing new sends.')],
    t('لا تحذف ملف جلسة OpenWA ولا تنقل الرسائل تلقائيًا إلى Meta.','Do not delete the OpenWA session profile or automatically transfer sends to Meta.'),
    t('صعّد إلى مسؤول البنية إذا تكرر فقد الاتصال أو ظل Gateway غير متاح.','Escalate to infrastructure if disconnects recur or the gateway remains unreachable.'),'sessions'),
  proc('qr-relink','onboarding','p2','admin',
    t('انتهاء QR أو طلب إعادة ربط','QR expired or relink required'),
    t('waiting_qr أو logged_out أو رمز QR لم يعد صالحًا','waiting_qr/logged_out or QR code is no longer valid'),
    [t('تحقق من اتصال الجلسة الصحيح وهوية المسؤول الذي سيعيد الربط.','Verify the exact connection and the authorized administrator performing relink.'),
     t('اطلب QR جديدًا من واجهة الجلسة الحالية فقط؛ اعرضه للمسؤول المخوّل دون نسخه للدعم.','Request a fresh QR only for the existing session; show it to authorized admins without sharing it with support.'),
     t('اربط الجهاز ثم اضغط تحديث الحالة للتحقق من الجاهزية الفعلية.','Relink the device and refresh state to verify actual readiness.'),
     t('راجع صلاحيات الإرسال وPilot والمراجعات المعلقة بعد الربط.','Recheck outbound approval, Pilot and pending review records after linking.')],
    t('لا ترسل صور QR أو ملفات الجلسة أو بيانات المصادقة في تذاكر الدعم.','Never attach QR images, session files or authentication material to support tickets.'),
    t('صعّد عند تكرار فشل QR أو وجود تضارب هوية جلسة.','Escalate recurrent QR failure or session-identity mismatch.'),'sessions'),
  proc('policy-not-approved','governance','p2','owner',
    t('السياسة غير معتمدة أو لا تظهر نصوصها','Policy not approved or approved text missing'),
    t('policy_not_approved أو عدم توفر النص المعتمد','policy_not_approved or approved policy wording is unavailable'),
    [t('راجع تبويب الموافقات للتأكد من وجود إصدار معتمد ونص عربي وإنجليزي مطابق.','Inspect Governance for an approved version and matching Arabic/English terms.'),
     t('اطلب مراجعة Product/Legal وإصدارًا موثقًا قبل نشر السياسة في قاعدة البيانات.','Obtain Product/Legal sign-off and a documented version before publishing the policy to the database.'),
     t('لا تفعّل مفتاح قبول السياسة أو الإرسال الإنتاجي لتجاوز نقص الاعتماد.','Keep acceptance and production release switches closed; missing approvals are not bypassable.')],
    t('لا تقبل المسودة أو تجزئة SHA-256 وحدها نيابة عن المالك.','Never accept a draft or a bare SHA-256 digest on the owner’s behalf.'),
    t('التصعيد إلى مالك المنتج والشؤون القانونية لمراجعة النص والإصدار.','Escalate to Product and Legal for signed wording and version.'),'governance'),
  proc('consent-stale','governance','p2','owner',
    t('موافقة قديمة أو مسحوبة','Outdated or revoked consent'),
    t('consent_required أو consent_outdated أو consent_changed','consent_required, consent_outdated or consent_changed'),
    [t('راجع سبب المنع وإصدار السياسة الحالية وسجل التدقيق.','Check the denial reason, current policy version and audit history.'),
     t('إذا سحبت الموافقة، لا تعيد التفعيل تلقائيًا؛ يتطلب قبولًا جديدًا صريحًا من المالك.','If consent was revoked, do not restore it automatically; the owner must explicitly reaccept approved terms.'),
     t('بعد قبول المالك، يعيد المسؤول اعتماد الاتصال المحدد فقط عند فتح بوابات الخادم.','After owner acceptance, an admin may reactivate only the named connection if server gates permit.'),
     t('تحقق من شروط المستلمين والإرسال المستقل حتى بعد حالة التفعيل المطلوبة.','Check recipient and send-specific policies even if activation is recorded.')],
    t('لا تتعامل مع Pilot أو حالة ready على أنها موافقة إنتاجية.','Do not treat Pilot or session ready as production consent.'),
    t('صعّد إلى مالك الحساب عند النزاع حول القبول أو سحبه.','Escalate acceptance or revocation disputes to the account owner.'),'governance'),
  proc('test-schema-unavailable','governance','p2','admin',
    t('عدم توفر بيانات الموافقات (503)','Consent control unavailable (503)'),
    t('control_unavailable أو واجهة الموافقات لا تحمل معلومات','control_unavailable or governance screen fails to load'),
    [t('تحقق من أن تطبيق Windows يتصل ببيئة TEST المقصودة دون عرض مفاتيحها.','Confirm the Windows app targets the intended TEST environment without exposing its secrets.'),
     t('افحص migration 204 وتطبيقها عبر مسار TEST المعتمد والأدلة المتاحة.','Review migration 204 and its approved TEST application evidence.'),
     t('راجع صلاحيات المالك/المسؤول وصحة الخدمة من سجلات خادم منقّحة.','Check owner/admin role and service health using redacted server evidence.'),
     t('أبقِ إجراءات التفعيل مغلقة إذا لم يمكن إثبات الحالة من قاعدة البيانات.','Keep activation closed if database state cannot be verified.')],
    t('لا تعالج 503 بفتح RLS أو service-role في المتصفح أو ادعاء عدم وجود جلسات.','Never fix a 503 by weakening RLS, exposing service-role, or pretending there are no sessions.'),
    t('صعّد إلى مسؤول قاعدة بيانات TEST أو الأمن بعد حفظ زمن الحادث ورمز HTTP فقط.','Escalate to TEST database/security owners with timestamp and HTTP status only.'),'governance'),
  proc('send-restricted','delivery','p1','admin',
    t('منع إرسال أو تقييد اتصال','Outbound restricted or connection blocked'),
    t('connection_restricted أو session restricted أو وقف يدوي','connection_restricted, restricted session or manual STOP'),
    [t('حدد سبب المنع في الموافقات وPilot ولا تفترض أنه خلل تقني.','Identify the denial reason under Governance/Pilot; a refusal is not automatically a defect.'),
     t('إذا كان الاتصال restricted، أوقف إرسال الجلسة الجديدة وراجع سياسة الرسائل والمستلمين.','If restricted, pause new sends and review messaging and recipient policies.'),
     t('راجع حالة Gateway وموافقة المالك وقيود الحساب قبل أي إعادة تمكين مقصودة.','Review gateway, owner consent and account guardrails before any deliberate reenable.'),
     t('إذا تكرر المنع، احفظ تقرير الدعم المنقح وصعّد دون إرسال تجريبي متكرر.','If denial persists, preserve a sanitized handoff and escalate without repeated test sends.')],
    t('لا تتحايل على قيود واتساب ولا تغيّر المزود تلقائيًا لتجاوز المنع.','Never evade platform restrictions or silently switch provider to bypass denial.'),
    t('تصعيد عاجل إلى المسؤول الأمني/التشغيلي عند الاشتباه في إساءة استخدام أو حظر.','Urgent Security/Operations escalation for suspected abuse or platform block.'),'governance'),
  proc('ambiguous-outbound','delivery','p1','admin',
    t('مهلة إرسال ونتيجة غير مؤكدة','Send timeout or ambiguous outcome'),
    t('ambiguous_outcome أو OpenWA request timed out','ambiguous_outcome or an OpenWA request timed out'),
    [t('أبقِ هوية العملية الأصلية محفوظة ولا تولّد محاولة جديدة بذات الرسالة.','Preserve the original operation identity; do not start a fresh logical send.'),
     t('افتح مراجعة الإرسال للحساب ثم اتصال الجلسة المحدد.','Open the account-wide outbound review and select the affected connection.'),
     t('اطلب دليل المزوّد الأصلي حيث يدعمه النظام وقارن الهوية بدقة.','Inspect provider-native evidence when available and correlate by exact identity.'),
     t('أغلق الحالة كـclosed_unverified إذا تعذر إثبات النتيجة وسمحت صلاحيات المراجعة؛ لا تدّع التسليم.','If proof is insufficient, use closed_unverified only where the audited control permits; never claim delivery.'),
     t('احتفظ بدليل التسوية والسبب والتوقيت للمراجعة اللاحقة.','Preserve the reconciliation evidence, reason and timing for follow-up.')],
    t('ممنوع إعادة الإرسال العمياء أو تحويل مهلة الشبكة إلى delivered أو failed.','Never blindly resend or convert a network timeout to delivered or failed.'),
    t('صعّد إلى مسؤول التسليم إذا تضاربت الأدلة الأصلية أو وُجد خطر تكرار فعلي.','Escalate conflicting native evidence or duplicate-send risk to Delivery Engineering.'),'reviews'),
  proc('unmatched-ack','delivery','p2','admin',
    t('إيصال ACK لا يطابق رسالة','Unmatched ACK / receipt'),
    t('unmatched_status أو حالة في قائمة deferred','unmatched_status or a deferred status record'),
    [t('راجع الإجمالي للحساب وحدد الاتصال المتأثر بدل فتح كل جلسة دفعة واحدة.','Review the account aggregate and select the affected connection instead of opening all sessions.'),
     t('استخدم فحص الدليل الأصلي دون تعديل نتيجة التسليم تلقائيًا.','Use native evidence inspection without automatically changing delivery status.'),
     t('إن لم يوجد ربط موثّق، استخدم التسوية التشغيلية غير المؤكدة مع السجل والسبب فقط عند توفرها.','If no verified correlation exists, use audited unverified closure only where explicitly supported.'),
     t('راقب تكرار نفس النوع بعد التسوية وافتح علة هندسية إذا استمر.','Monitor recurring unmatched receipts and raise an engineering issue if persistent.')],
    t('لا تضع علامة delivered استنادًا إلى وصول ACK غير مرتبط.','Do not mark delivered solely because an unmatched ACK arrived.'),
    t('صعّد إلى مهندس التسوية عند وجود أحداث متعددة متضاربة.','Escalate multiple conflicting receipt identities to Reconciliation Engineering.'),'reviews'),
  proc('lid-unresolved','delivery','p2','admin',
    t('رسالة واردة بهوية LID غير محلولة','Unresolved inbound LID identity'),
    t('unresolved_identity ولا يوجد senderPhone موثّق','unresolved_identity with no verified senderPhone'),
    [t('افتح التسوية المؤجلة للاتصال نفسه وحدد حالة الهوية غير المحلولة.','Inspect the same connection’s deferred reconciliation and unresolved-identity state.'),
     t('نفّذ التحقق الموثّق من ربط الرقم عبر Gateway إذا كانت الميزة متاحة.','Use the gateway-backed phone proof workflow only if supported.'),
     t('أعد المعالجة عبر المسار الموحد بعد إثبات الهوية، ثم تحقق من عدم التكرار.','Reprocess through the unified inbound path after proof, then check deduplication.')],
    t('لا تستنتج رقم الهاتف من @lid ولا تنشئ جهة اتصال برقم مخمّن.','Never infer a phone number from @lid or create a guessed contact.'),
    t('صعّد إلى مسؤول تكامل الهوية إذا تعذر الإثبات من Gateway.','Escalate missing gateway identity proof to the integration owner.'),'reviews'),
  proc('webhook-degraded','operations','p1','admin',
    t('تعطل Webhook أو تأخر حالات القراءة','Webhook / read receipt degradation'),
    t('HTTP 401/404/503 أو تأخر ACK/read','HTTP 401/404/503 or delayed ACK/read receipts'),
    [t('تحقق من عنوان webhook الصحيح واختبار الاتصال ضمن إعدادات الجلسة، دون نقل مفتاح التوقيع.','Verify the selected session’s webhook configuration and connectivity without copying signing keys.'),
     t('افحص حالة التوقيع وحماية إعادة التشغيل والتكرار في السجلات المنقّحة.','Inspect signature, replay and deduplication controls in redacted logs.'),
     t('راجع deferred backlog ومحاولات المعالجة دون تنفيذ replay عشوائي.','Review deferred backlog and processing attempts without arbitrary replay.'),
     t('أثبت التعافي بدليل تجريبي مصرح به لاحقًا ولا تزعم وصول رسائل تاريخية.','Prove recovery with separately authorized TEST evidence later; do not infer past delivery.')],
    t('لا توقف التحقق من HMAC أو tenant isolation لجعل webhook يستجيب.','Never disable HMAC validation or tenant isolation to make webhooks pass.'),
    t('صعّد إلى مالك Gateway/Webhook عند استمرار الخطأ أو اتساع backlog.','Escalate persistent intake errors or growing backlog to Gateway/Webhook Engineering.'),'sessions'),
  proc('workers-overlap','operations','p0','admin',
    t('أكثر من عامل إرسال لبيئة واحدة','Duplicate outbound workers on one environment'),
    t('Windows وVPS يعالجان الطابور نفسه أو حجوزات تتكرر','Windows and VPS consume the same queue or reservations duplicate'),
    [t('أوقف المصدر المكرر من مسار إدارة العمال المعتمد، واحتفظ بمالك تشغيل واحد فقط.','Contain the duplicate worker using approved worker controls; retain a single processing owner.'),
     t('تحقق من حالة التشغيل في Windows وVPS بشكل مستقل؛ إيقاف واجهة المتصفح لا يوقف scheduler.','Verify Windows and VPS runtime separately; closing the browser does not stop a server scheduler.'),
     t('جمّع أرقام الحجز ونتائج الإرسال غير المؤكدة في التسوية دون إعادة إرسال.','Reconcile uncertain reservations and outcomes without resending.'),
     t('لا تستأنف العمال حتى تُثبت حدود الملكية والتزامن والـidempotency.','Do not resume workers until ownership, concurrency and idempotency are verified.')],
    t('لا تشغل عامل Windows بالتزامن مع scheduler على VPS لنفس قاعدة TEST.','Never run Windows and VPS workers concurrently against the same TEST queue.'),
    t('تصعيد فوري لمالك التشغيل والتسليم والتدقيق الأمني.','Immediately escalate to Operations, Delivery and Security.'),'reviews'),
  proc('media-uncertain','delivery','p2','admin',
    t('وسائط أُرسلت دون حالة مؤكدة','Media delivery not confirmed'),
    t('صورة أو فيديو أو مستند عالق في مرحلة ACK','Image, video or document awaiting receipt confirmation'),
    [t('تحقق من حالة الحجز ومحاولة الوسائط الأصلية في سجل المراجعات.','Review the original media reservation and outbound attempt.'),
     t('استخدم دليل Gateway الأصلي للوسائط إن أمكن وربطه بمعرّف الرسالة الموجود.','Correlate gateway-native media evidence to the existing provider message identity.'),
     t('ميّز بين قبول المزوّد والتسليم للعميل، واترك المجهول غير مؤكّد.','Separate provider acceptance from end-user delivery; keep unknown results unverified.')],
    t('لا تعيد رفع الملف أو إرساله آليًا قبل التسوية الموثقة.','Do not automatically reupload or resend media before evidence-based reconciliation.'),
    t('صعّد إلى مهندس الوسائط/ACK إذا فقدت هوية المزوّد أو كان هناك احتمال ازدواج.','Escalate missing provider identity or duplicate risk to Media/ACK Engineering.'),'reviews'),
  proc('credentials-risk','security','p0','owner',
    t('اشتباه تسريب مفتاح أو وصول غير مصرح','Suspected credential leak or unauthorized access'),
    t('مفتاح Gateway أو session token أو QR ظهر خارج النطاق المخوّل','Gateway key, session token or QR appears outside authorized access'),
    [t('أوقف الإرسال الجديد على الاتصال المتأثر وقيّد وصول المشغلين حسب إجراءات الحوادث.','Contain new outbound sends on the affected connection and limit operator access.'),
     t('بلّغ مسؤول الأمن فورًا باستخدام مرجع الحادث، دون نسخ المفتاح أو صورة QR.','Notify Security immediately with an incident reference, without copying secrets or QR.'),
     t('نفّذ تدوير بيانات الاعتماد فقط عبر آلية مخوّلة مع تحقق هوية الجلسة والـwebhook.','Rotate credentials only via authorized procedures, verifying session and webhook identity.'),
     t('راجع audit ووقت الحادث والاتصالات المتأثرة ثم وثّق الاستعادة دون اختبارات إرسال غير مصرح بها.','Inspect audit, timeline and affected connections; document recovery without unauthorized sends.')],
    t('لا تُرسل أسرارًا في البريد أو سجل المتصفح أو تقرير الدعم، ولا تحذف أدلة التحقيق.','Never send secrets in email, browser logs or support reports, and do not destroy forensic evidence.'),
    t('تصعيد فوري إلى Security/Incident Commander والمالك.','Immediate escalation to Security/Incident Commander and account owner.'),'sessions'),
  proc('meta-not-ready','onboarding','p2','admin',
    t('تعذر اتصال Meta Cloud الرسمي','Official Meta Cloud connection unavailable'),
    t('واجهة Meta لا تجتاز الاختبار أو ينتهي رمزها','Meta connection test fails or its token expires'),
    [t('راجع حالة Meta من تبويب Meta Cloud ثم نفّذ الاختبار التشخيصي المصرح.','Review Meta state in Meta Cloud and run the authorized connectivity check.'),
     t('تحقق من صلاحية الهوية والتوكن من الخادم دون كشف قيمته.','Validate provider identity and token server-side without displaying its value.'),
     t('أصلح إعدادات Meta الرسمية مع الحفاظ على اتصال OpenWA اختياريًا ومستقلًا.','Repair the official Meta integration without changing optional OpenWA sessions.')],
    t('لا تفعل تحويلًا تلقائيًا من Meta إلى OpenWA لتعويض انقطاع Meta.','Do not auto-failover Meta to OpenWA to compensate for an outage.'),
    t('صعّد إلى مسؤول Meta/API عند استمرار فشل الاتصال.','Escalate sustained Meta API failures to the official-provider owner.'),'meta'),
  proc('test-pilot-limits','operations','p3','admin',
    t('حدود TEST Pilot تمنع مهمة','TEST Pilot caps block a task'),
    t('daily_cap أو hourly_cap أو TEMPLATE_REQUIRED أو cohort غير مخوّل','daily_cap, hourly_cap, TEMPLATE_REQUIRED or cohort not authorized'),
    [t('افتح Pilot وحدد جلسة المهمة، والحد الساعي/اليومي والمستلمين المعتمدين.','Open Pilot for the task’s exact session; review hourly/daily caps and approved cohort.'),
     t('افصل بين متطلبات قالب Meta الرسمية ومتطلبات TEST Pilot الخاصة بـOpenWA.','Distinguish official Meta template requirements from OpenWA TEST Pilot rules.'),
     t('إذا لزم تغيير الحدود، استخدم ضوابط TEST المعتمدة مع موافقة مسؤول التشغيل.','If limits need adjustment, use approved TEST-only admin controls with operational approval.')],
    t('لا تلغِ حد مكافحة الإساءة في Production ولا تستخدم Pilot كبديل لموافقة المستلم.','Never disable production anti-abuse limits or treat Pilot as recipient consent.'),
    t('صعّد إلى مالك المهام/التشغيل إذا بقي الحظر بعد التحقق من كل شرط.','Escalate to task/operations owner if the block persists after verification.'),'pilot'),
  proc('account-isolation','security','p0','owner',
    t('شبهة اختلاط بيانات حسابين','Potential cross-tenant information exposure'),
    t('نتائج جلسات أو Audit تخص حسابًا آخر','Session or audit results appear to belong to another account'),
    [t('أوقف أي إجراء إداري أو إرسال متعلق بالمجموعة المتأثرة فورًا.','Immediately contain administrative actions and sending for the affected scope.'),
     t('سجل رمز الحدث والوقت والمنطقة المتأثرة فقط، دون نسخ البيانات الظاهرة.','Record incident code, time and impacted area only; do not copy exposed records.'),
     t('أبلغ الأمن وأوقف النشر حتى مراجعة requireRole وRLS وحدود الخدمة.','Alert Security and hold rollout until requireRole, RLS and service scoping are reviewed.')],
    t('لا تعطل RLS أو توسع صلاحيات service_role لاستعادة التشغيل.','Never disable RLS or broaden service-role permissions to restore service.'),
    t('تصعيد P0 إلى المسؤول الأمني ومالك الحادث.','P0 escalation to Security and the incident commander.'),'governance'),
]

export const OPENWA_SUPPORT_GUIDES: readonly SupportGuide[] = [
  { id:'new-session',topic:'onboarding',title:t('إنشاء جلسة بصورة آمنة','Safely onboard a session'),description:t('اختبر Gateway قبل الإنشاء ثم أعد الربط دون إنشاء نسخ مكررة.','Validate the gateway before creation; relink without duplicates.'),
    destination:'sessions',steps:[t('تأكد من صلاحية Admin وحدد بيئة TEST الصحيحة.','Confirm admin role and intended TEST environment.'),
      t('من تبويب الجلسات أدخل الاسم والرابط الآمن والمفتاح دون مشاركته مع الدعم.','Use Sessions to enter name, HTTPS gateway URL and key without sharing them.'),
      t('اختبر إمكانية الوصول ثم أنشئ اتصالًا واحدًا، وإذا انتهت مهلة الإنشاء راجع القائمة أولًا.','Check reachability, create one connection, and inspect the list if creation times out.'),
      t('اعرض QR للمسؤول فقط وتحقق من Ready ومن ربط webhook.','Display QR only to an authorized admin and verify Ready and webhook pairing.'),
      t('افصل جاهزية الجلسة عن موافقة المالك وحدود Pilot.','Keep session readiness separate from owner approval and TEST Pilot limits.')] },
  { id:'approve-provider',topic:'governance',title:t('اعتماد OpenWA وتفعيل الاتصال','Approve OpenWA and request activation'),description:t('مسار مالك الحساب ثم المسؤول، بعد اعتماد النسخة القانونية.','Owner-first and admin-next workflow after legally approved publication.'),
    destination:'governance',steps:[t('راجع أن Product/Legal اعتمدا نصين عربيًا وإنجليزيًا وبصمة مطابقة للنسخة المسجلة.','Verify Product/Legal approved complete Arabic/English terms matching the published digest.'),
      t('يقرأ المالك النص المعتمد ويقبله صراحة إذا فُتحت بوابة القبول على الخادم.','The owner reviews and explicitly accepts the published wording once server acceptance opens.'),
      t('يفعّل Admin الاتصال المعني فقط بعد جاهزية الجلسة، دون تخطي بوابات الموافقة.','An admin may enable only the ready target connection after approval.'),
      t('راجع أن الإرسال الحقيقي ما زال يحتاج recipient policy وPilot وSTOP وبوابة النشر.','Confirm each dispatch still requires recipient policy, Pilot, STOP and release gates.')] },
  { id:'emergency-containment',topic:'security',title:t('احتواء حادث وإيقاف الإرسال','Contain an incident and stop outbound sends'),description:t('إيقاف آمن ومحدود دون مسح جلسة أو دليل.','Scope-limited containment without deleting session or evidence.'),
    destination:'sessions',steps:[t('حدد نطاق الحادث والحساب والاتصال الصحيحين دون مشاركة معرفاتهما في تقرير عام.','Identify the exact incident/account/connection without putting identifiers in a public report.'),
      t('اضغط إيقاف الإرسال للجلسة أو تعليق تفعيلها حسب الصلاحيات والسياسة.','Use the session emergency STOP or suspend activation as allowed by server policy.'),
      t('أوقف أي Worker مكرر عبر بيئة تشغيله الفعلية، وليس بمجرد إغلاق نافذة المستخدم.','Contain duplicate workers at their true runtime owners, not by closing the UI.'),
      t('راجع التسوية واكتب أدلة مؤرخة منقحة قبل أي استئناف.','Review reconciliation and record redacted evidence before resuming.')] },
  { id:'restore-session',topic:'onboarding',title:t('إعادة الربط والتعافي من انقطاع الجلسة','Relink and recover a disconnected session'),description:t('إجراءات مفصولة عن إعادة إرسال الرسائل.','Recovery separate from retransmitting messages.'),
    destination:'sessions',steps:[t('تحقق من عدم وجود محاولة إنشاء بعيدة معلقة أو جلسة مكررة.','Check for outstanding remote creation and duplicate sessions.'),
      t('تحقق من Gateway وwebhook قبل QR جديد أو إعادة الاتصال.','Check gateway and webhook before new QR or reconnect.'),
      t('أعد الربط للجلسة نفسها وراقب ready/connected.','Relink the same connection and confirm ready/connected.'),
      t('افحص الرسائل غير المؤكدة، ولا تفترض أن انقطاع الجلسة يعني فشلها.','Review uncertain sends; disconnection does not prove prior failure.')] },
  { id:'reconcile-evidence',topic:'delivery',title:t('تسوية الرسائل وACK دون إعادة إرسال','Reconcile sends and ACK without resend'),description:t('التفريق بين النتيجة المؤكدة والمجهولة وإبقاء سجل تدقيق.','Distinguish confirmed and unknown outcomes with an audit trail.'),
    destination:'reviews',steps:[t('ابدأ ببطاقة إجمالي المراجعات للحساب ثم اختر الاتصال المتأثر.','Start with the single account-wide review hub, then choose the affected session.'),
      t('ميّز outbound unknown عن ACK غير مطابق وعن هوية LID غير محلولة.','Distinguish uncertain outbound from unmatched ACK and unresolved LID.'),
      t('استخدم الأدلة الأصلية أو التحقق الموثق من الهوية إن كان متاحًا.','Use native provider proof or verified identity lookup when available.'),
      t('أغلق الحالة غير المثبتة فقط باستخدام closed_unverified مع السبب وسجل التدقيق حيث تسمح الواجهة.','Use closed_unverified with reason and audit only where the UI permits.'),
      t('لا تختر delivered أو failed على أساس التخمين ولا تُعد إرسال المحتوى تلقائيًا.','Never guess delivered/failed or automatically retransmit.')] },
  { id:'test-admission',topic:'operations',title:t('تشخيص منع مهام TEST','Troubleshoot TEST task admission'),description:t('تحقق من الاتصال والحدود والموافقة على المستهدف، دون تخفيف إنتاجي.','Check connection, limits and recipient permission without weakening production policy.'),
    destination:'pilot',steps:[t('راجع اتصال المهمة المحدد وليس الرقم الظاهر فقط.','Check the exact task-selected connection, not only its phone identity.'),
      t('تحقق من Pilot cohort وحدود الساعة واليوم وحالة STOP.','Inspect Pilot cohort, hourly/daily caps and emergency STOP.'),
      t('راجع متطلبات Meta template إن كانت المهمة موجهة إلى Meta الرسمية.','Inspect Meta template requirements if the task uses official Meta.'),
      t('تجنب إعادة معالجة مهام مبهمة قبل تسوية محاولاتها السابقة.','Avoid replaying ambiguous tasks before resolving prior attempts.')] },
  { id:'handoff-support',topic:'operations',title:t('تسليم حادث إلى فريق الدعم','Prepare a safe support handoff'),description:t('موجز منقح لا يشمل أي سر أو رقم هاتف أو مضمون رسالة.','Redacted summary without secrets, phone numbers or message content.'),
    destination:'reviews',steps:[t('حدد نوع العطل وشدته والمكوّن والمسؤول المعني.','Identify the symptom, severity, component and responsible owner.'),
      t('شغّل الفحص الآمن من هذا المركز إن سمحت صلاحياتك، أو اطلب من Admin تنفيذه.','Run the read-only diagnostic here if authorized, or ask an admin.'),
      t('انسخ التقرير المنقح فقط، وأضف رقم مرجع حادث داخلي دون تفاصيل عملاء.','Copy only the sanitized report and add an internal incident reference.'),
      t('سلّم النتائج عبر قناة دعم داخلية معتمدة، واطلب فحص الدليل قبل إعادة المحاولة.','Handoff through an approved internal support channel and require proof before retry.')] },
  { id:'release-readiness',topic:'governance',title:t('مراجعة بوابات النشر قبل الإنتاج','Review production release prerequisites'),description:t('قائمة تحقق لا تمنح إذنًا للإطلاق بمجرد إتمامها.','Checklist that does not itself authorize a release.'),
    destination:'governance',steps:[t('تحقق من W07-02 migration وW07-03 API وW07-04 gate وW07-05 UI وأدلة CI الدقيقة.','Verify migration, API, pre-dispatch gate, UI and exact-HEAD CI evidence.'),
      t('احصل على موافقة Product/Legal/Security وموافقة مالك الحساب، دون اعتماد تلقائي.','Obtain Product/Legal/Security and owner approvals; no automatic consent.'),
      t('تحقق من W06 النسخ/الاستعادة وNOTE-001 وW08 وW09 GO/NO-GO.','Verify W06 backup/restore, NOTE-001, W08 and W09 GO/NO-GO.'),
      t('نفّذ قبول TEST الحي المحدود فقط عند تفويض منفصل، ثم راجع الأدلة قبل أي نشر.','Perform bounded live TEST acceptance only under separate authorization; review evidence before rollout.')] },
]

export const OPENWA_SUPPORT_FAQS: readonly SupportFaq[] = [
  {id:'which-provider',topic:'onboarding',question:t('هل يحل OpenWA محل Meta Cloud؟','Does OpenWA replace Meta Cloud?'),answer:t('لا، Meta Cloud المزود الرسمي والافتراضي، وOpenWA طبقة نقل إضافية اختيارية. لا يوجد تحويل تلقائي أو تغيير مزود صامت.','No. Meta Cloud is the official/default provider and OpenWA is an optional transport. There is no automatic or silent fallback.')},
  {id:'ready-equals-send',topic:'governance',question:t('هل Ready أو طلب تفعيل الاتصال يسمح بالإرسال؟','Does Ready or requested activation authorize sending?'),answer:t('لا. تفحص W07-04 الموافقة الحالية والاتصال وقيود الإرسال والمستلم عند كل رسالة. وفي TEST يبقى Pilot مستقلًا.','No. W07-04 verifies active policy, connection, recipient and send safeguards for each dispatch; TEST Pilot is independent.')},
  {id:'who-accepts',topic:'governance',question:t('من يوافق على سياسة OpenWA؟','Who may accept OpenWA terms?'),answer:t('مالك الحساب فقط بعد نشر صياغة قانونية معتمدة مطابقة لبصمتها. المسؤول يمكنه رؤية الحالة، لا التوقيع نيابة عنه.','Only the account owner after reviewed wording and matching digest are published. Admins may inspect the status but cannot sign for the owner.')},
  {id:'503',topic:'governance',question:t('لماذا تظهر صفحة الموافقات 503؟','Why does Governance return 503?'),answer:t('قد تكون migration 204 أو أدلة قاعدة البيانات غير متوفرة. هذه حالة منع آمن وليست موافقة أو قائمة فارغة. راجع فريق TEST قبل أي تغييرات.','Migration 204 or DB evidence may be unavailable. This is a safe refusal, not approval or an empty state. Ask TEST operations before changes.')},
  {id:'qr',topic:'onboarding',question:t('هل يمكن إرسال QR إلى الدعم؟','May I share a QR code with support?'),answer:t('لا. QR وملف الجلسة والمفاتيح خاصة بالمسؤول المخوّل. اطلب الرمز من واجهة الجلسة ولا تضعه في تذكرة دعم.','No. QR, session profile and keys are privileged. Use the session UI and never attach QR to support requests.')},
  {id:'timeout',topic:'delivery',question:t('هل أعيد إرسال رسالة بعد timeout؟','Should I resend after a timeout?'),answer:t('لا. timeout قد يعني أن الطلب وصل للمزوّد. راجع reconciliation والدليل الأصلي لتجنب إرسال مزدوج.','No. A timeout may occur after provider acceptance. Use reconciliation and native proof to avoid duplicate sends.')},
  {id:'unverified',topic:'delivery',question:t('ما معنى closed_unverified؟','What does closed_unverified mean?'),answer:t('إغلاق إداري لحالة لا يوجد لها دليل تسليم كافٍ؛ لا يعني أن الرسالة وصلت أو فشلت، ولا يعيد إرسالها.','An audited administrative closure without enough delivery proof; it is not success, failure or a resend.')},
  {id:'lid',topic:'delivery',question:t('هل يمكن معرفة الهاتف من رقم @lid؟','Can a phone be inferred from a @lid identifier?'),answer:t('لا. هوية LID ليست رقم هاتف. لا تُربط بجهة اتصال إلا بدليل أصلي موثّق.','No. LID is not a phone number. Link it only with verified native evidence.')},
  {id:'pilot-prod',topic:'operations',question:t('هل تعطيل Pilot يفعّل الإنتاج؟','Does disabling Pilot enable Production?'),answer:t('لا. Pilot يخص ضوابط TEST، بينما الموافقة وبوابة W07 والنشر وأذونات المستلمين مستقلة.','No. TEST Pilot controls are independent from W07 owner consent, production release and recipient permissions.')},
  {id:'stop-workers',topic:'operations',question:t('هل إغلاق برنامج Windows يوقف عامل السيرفر؟','Does closing Windows stop the server worker?'),answer:t('لا. عامل Windows وعامل VPS خدمتان منفصلتان؛ تحقق من التشغيل الفعلي لكليهما لتجنب عملين على نفس طابور TEST.','No. Windows and VPS worker ownership is independent. Verify both runtimes to avoid dual consumption of one TEST queue.')},
  {id:'support-data',topic:'security',question:t('ما البيانات المسموح إرسالها للدعم؟','Which details may be shared with support?'),answer:t('الرموز العامة للحالة والأعداد وزمن الفحص ونوع المشكلة فقط. لا ترسل مفاتيح أو QR أو هاتفًا أو JID أو محتوى رسائل أو روابط خاصة أو سجلات خامًا.','Only coarse status codes, counts, check time and symptom category; no keys, QR, phone, JID, message bodies, private URLs or raw logs.')},
  {id:'backup',topic:'operations',question:t('هل لدينا ضمان استعادة جلسات OpenWA؟','Is OpenWA session recovery guaranteed?'),answer:t('لا. لا تُعد SLA أو RTO أو RPO قبل إثبات نسخ احتياطي واستعادة معزولة ضمن W06 المؤجلة.','No. Do not promise SLA, RTO or RPO without proven backups and isolated restore under deferred W06.')},
  {id:'meta-down',topic:'onboarding',question:t('هل يتحول الإرسال إلى OpenWA عند تعطل Meta؟','Does Meta outage trigger OpenWA fallback?'),answer:t('لا يوجد تحويل تلقائي. يتطلب أي اختيار صريح لاتصال آخر أذونات المستلم والموافقة وضوابط المزود المستقل.','No automatic fallback. Explicitly selecting another connection still requires recipient permission, consent and provider safeguards.')},
]

export const OPENWA_SUPPORT_TOPICS: Readonly<Record<SupportTopic, SupportText>> = {
  onboarding: t('الاتصالات والربط','Connections & onboarding'),
  governance: t('الموافقة والصلاحيات','Consent & permissions'),
  delivery: t('الإرسال والتسوية','Delivery & reconciliation'),
  security: t('الأمن والحوادث','Security & incidents'),
  operations: t('التشغيل وPilot','Operations & Pilot'),
}

export const OPENWA_SUPPORT_SEVERITIES: Readonly<Record<SupportSeverity, SupportText>> = {
  p0: t('حرج · احتواء فوري','Critical · contain immediately'),
  p1: t('عالٍ · تصعيد عاجل','High · urgent escalation'),
  p2: t('متوسط · تدخل من المسؤول','Medium · admin action'),
  p3: t('منخفض · مساعدة تشغيلية','Low · operational help'),
}

export const OPENWA_SUPPORT_ROLES: Readonly<Record<SupportRole, SupportText>> = {
  owner: t('مالك الحساب','Account owner'),
  admin: t('مسؤول الحساب','Account administrator'),
  support: t('فريق الدعم · إرشاد فقط','Support · guidance only'),
}

export function localizeSupport(copy: SupportText, language: string): string {
  return language.toLowerCase().startsWith('ar') ? copy.ar : copy.en
}

export function findOpenWASupportProcedure(id: string): SupportProcedure | null {
  return OPENWA_SUPPORT_PROCEDURES.find(item => item.id === id) ?? null
}

export function searchOpenWASupport(
  language: string, search: string, topic: SupportTopic | 'all' = 'all',
): SupportProcedure[] {
  const normalized = search.trim().toLocaleLowerCase().slice(0, 120)
  return OPENWA_SUPPORT_PROCEDURES.filter(item => {
    if (topic !== 'all' && topic !== item.topic) return false
    if (!normalized) return true
    // Cross-language lookup so common codes/symptoms remain discoverable
    // even when the operator uses the other UI locale.
    const haystack = [item.id, item.title.ar, item.title.en, item.symptom.ar,
      item.symptom.en, item.avoid.ar, item.avoid.en, item.escalate.ar, item.escalate.en,
      ...item.steps.flatMap(step => [step.ar, step.en])]
      .join(' ').toLocaleLowerCase()
    return haystack.includes(normalized)
  })
}
