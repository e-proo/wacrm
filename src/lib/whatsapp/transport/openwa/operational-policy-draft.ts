import type { AccountRole } from '@/lib/auth/roles'

/** W07-00/01 draft only: NOT an authorization or production send gate. */
export const OPENWA_POLICY_DRAFT = Object.freeze({
  id: 'openwa-linked-device-usage',
  version: 'ow14-w07-draft-2026-11-20-v1',
  state: 'draft',
  productionEnabledByDefault: false,
  pilotCountsAsConsent: false,
  reviewCreatesConsent: false,
})

export type OpenWADraftAction = 'review' | 'accept' | 'revoke' | 'activate'
/** Proposed permissions; W07-03 must enforce these at the server boundary. */
export function proposedOpenWAPermission(role: AccountRole | null | undefined, action: OpenWADraftAction): boolean {
  if (!role) return false
  if (action === 'review') return true
  if (action === 'accept' || action === 'revoke') return role === 'owner'
  return role === 'owner' || role === 'admin'
}

export interface PolicyCopy {
  title: string
  subtitle: string
  badge: string
  notice: string
  meta: { name: string; tag: string; body: string; link: string }
  openwa: { name: string; tag: string; body: string; link: string }
  reviewButton: string
  reviewTitle: string
  reviewSubtitle: string
  riskTitle: string
  risks: readonly { title: string; description: string }[]
  stepsTitle: string
  steps: readonly { name: string; description: string; state: string }[]
  consentBoundary: { title: string; body: string }
  helpTitle: string
  helpSubtitle: string
  faq: readonly { question: string; answer: string }[]
  close: string
}
const ar: PolicyCopy = {
  title: 'مزوّدو اتصال واتساب',
  subtitle: 'قارن بين الاتصال الرسمي وواتساب ويب، وراجع المخاطر قبل تفعيل أي اتصال للإنتاج.',
  badge: 'معاينة سياسة التشغيل',
  notice: 'هذه معاينة معلوماتية فقط. الموافقة التشغيلية للإنتاج لم تُفعّل بعد، ولا تحفظ هذه الشاشة أي موافقة. ضوابط Pilot على TEST مستقلة.',
  meta: {
    name: 'Meta Cloud API', tag: 'رسمي · الافتراضي',
    body: 'التكامل الرسمي مع Meta. يبقى الخيار الافتراضي في WACRM ولا يُستبدل تلقائيًا عند إضافة OpenWA.',
    link: 'إعدادات Meta',
  },
  openwa: {
    name: 'WhatsApp Web (OpenWA)', tag: 'اختياري · غير رسمي',
    body: 'نقل ذاتي الاستضافة عبر جهاز مرتبط. قد ينقطع أو يحتاج إلى إعادة ربط، وتختلف مخاطره عن Meta Cloud API.',
    link: 'إدارة جلسات OpenWA',
  },
  reviewButton: 'استعراض المخاطر والشروط',
  reviewTitle: 'مخاطر استخدام OpenWA',
  reviewSubtitle: 'نص عربي أولي يحتاج مراجعة المنتج والامتثال. القراءة لا تسجّل قبولًا ولا تسمح بالإرسال.',
  riskTitle: 'معلومات مهمة قبل التشغيل',
  risks: [
    { title: 'تكامل غير رسمي', description: 'OpenWA يستخدم WhatsApp Web عبر جهاز مرتبط، وليس واجهة Meta Cloud API الرسمية أو تكاملًا معتمدًا منها.' },
    { title: 'الاستمرارية وإعادة الربط', description: 'قد تنقطع الجلسة أو تحتاج QR جديدًا أو تصبح غير متاحة. لا يوجد ضمان للتوفر المستمر أو وصول كل رسالة.' },
    { title: 'السياسات وموافقات المستلمين', description: 'قد يتعرض الرقم لقيود WhatsApp. يجب احترام شروط المنصة والأنظمة وموافقات المستلمين وتجنب الرسائل غير المرغوبة.' },
    { title: 'نتائج إرسال غير مؤكدة', description: 'انتهاء مهلة الإرسال timeout لا يثبت الوصول أو الفشل. تُراجع الأدلة أولًا، دون إعادة إرسال عمياء.' },
    { title: 'أمان الجلسات والخصوصية', description: 'ملفات المصادقة والمفاتيح وQR حساسة وتُدار من قبل المسؤول المخوّل فقط. الاستعادة وإعادة الربط إجراءات تشغيلية.' },
  ],
  stepsTitle: 'مراحل السماح التشغيلي',
  steps: [
    { name: 'مراجعة الاختلافات والمخاطر', description: 'معلومات واضحة حول المزودين والمسؤوليات.', state: 'متاح' },
    { name: 'موافقة مالك الحساب', description: 'قبول مؤرخ لإصدار سياسة معتمد، ولم يُفعّل بعد.', state: 'قيد التجهيز' },
    { name: 'تفعيل الاتصال المحدد', description: 'اعتماد كل جلسة بصورة مستقلة بعد فحوصات الأمان.', state: 'قيد التجهيز' },
  ],
  consentBoundary: {
    title: 'الموافقة على مخاطر المزود ليست إذنًا بالإرسال',
    body: 'موافقة مالك الحساب لا تغني عن موافقات المستلمين أو سياسات الرسائل، ولا تبدأ عمال الإرسال تلقائيًا. إعدادات Pilot على TEST ليست تفعيلًا إنتاجيًا.',
  },
  helpTitle: 'المساعدة والأسئلة الشائعة',
  helpSubtitle: 'تعليمات تشغيلية لا تعدّل حالة الاتصال.',
  faq: [
    { question: 'هل ينتقل الإرسال تلقائيًا بين Meta وOpenWA؟', answer: 'لا. يبقى Meta المزود الرسمي الافتراضي، ويجب تحديد أي جلسة بديلة صراحةً وفق صلاحيات WACRM.' },
    { question: 'هل تعني جاهزية الجلسة أو تعطيل Pilot الموافقة الإنتاجية؟', answer: 'لا. جاهزية OpenWA وPilot على TEST أمران مختلفان عن الموافقة التشغيلية التي ستُنفذ لاحقًا.' },
    { question: 'ماذا أفعل إذا فصل واتساب الجلسة؟', answer: 'أوقف الإرسال الجديد، وراجع الحالة، ثم أعد الربط بإذن مسؤول. لا تحذف ملف الجلسة ولا تنشئ جلسة مكررة بلا تحقق.' },
    { question: 'ماذا أفعل إذا كانت نتيجة الرسالة مجهولة؟', answer: 'راجع أدلة المزود والتسوية في WACRM، ولا تعِد الإرسال تلقائيًا بعد timeout.' },
    { question: 'هل يكفي قبول هذه السياسة لإرسال بث إلى أي رقم؟', answer: 'لا. تظل موافقات المستلمين وسياسات WhatsApp ومراجعة الحملات وحدود الإرسال مطلوبة.' },
  ],
  close: 'إغلاق المراجعة',
}
const en: PolicyCopy = {
  title: 'WhatsApp providers',
  subtitle: 'Compare the official connection with WhatsApp Web and review risks before any production activation.',
  badge: 'Operational policy preview',
  notice: 'Informational preview only. Production operational opt-in is not implemented, and this screen saves no consent. TEST Pilot controls are separate.',
  meta: {
    name: 'Meta Cloud API', tag: 'Official · Default',
    body: 'The official Meta integration remains the WACRM default. Adding OpenWA never silently replaces it.',
    link: 'Meta settings',
  },
  openwa: {
    name: 'WhatsApp Web (OpenWA)', tag: 'Optional · Unofficial',
    body: 'Self-hosted linked-device transport. It can disconnect, require relinking and carries different risks than Meta Cloud API.',
    link: 'Manage OpenWA sessions',
  },
  reviewButton: 'Review risks and terms',
  reviewTitle: 'OpenWA usage risks',
  reviewSubtitle: 'Draft English wording pending Product/Legal review. Reading does not accept terms or enable sending.',
  riskTitle: 'Before using this transport',
  risks: [
    { title: 'Unofficial integration', description: 'OpenWA uses WhatsApp Web linked devices, not the official Meta Cloud API or an endorsed integration.' },
    { title: 'Uptime and relinking', description: 'A session can disconnect, require another QR, or become unavailable. Continuous availability and message delivery are not guaranteed.' },
    { title: 'Policies and recipient consent', description: 'WhatsApp restrictions may affect numbers. Respect platform rules, applicable laws, recipient permissions and anti-spam controls.' },
    { title: 'Uncertain delivery', description: 'A send timeout proves neither delivery nor failure. Review provider evidence; never blindly resend an uncertain message.' },
    { title: 'Session privacy and security', description: 'Auth profiles, keys and QR must remain confidential and admin-only. Recovery and relinking need controlled procedures.' },
  ],
  stepsTitle: 'Operational activation journey',
  steps: [
    { name: 'Understand providers and risks', description: 'Read the disclosure and operational responsibilities.', state: 'Available' },
    { name: 'Account-owner acceptance', description: 'Audited consent to an approved policy version; not implemented yet.', state: 'Planned' },
    { name: 'Enable a specific connection', description: 'Separate per-session activation after security checks.', state: 'Planned' },
  ],
  consentBoundary: {
    title: 'Provider risk acceptance is not permission to send',
    body: 'Owner acceptance does not replace recipient permission or WhatsApp policies, nor does it trigger queued sends. TEST Pilot is not production activation.',
  },
  helpTitle: 'Help and common questions',
  helpSubtitle: 'Operational guidance only; it never changes connection settings.',
  faq: [
    { question: 'Does WACRM silently switch Meta traffic to OpenWA?', answer: 'No. Meta stays the official default; using a different session requires explicit authorized selection.' },
    { question: 'Does Ready or disabled TEST Pilot mean production approval?', answer: 'No. Session readiness and TEST Pilot are separate from the future production opt-in.' },
    { question: 'What if a WhatsApp session disconnects?', answer: 'Hold new sends, check status, and have an authorized administrator relink. Avoid deleting profiles or creating duplicate sessions without review.' },
    { question: 'What if a send has an uncertain outcome?', answer: 'Review provider evidence and the WACRM reconciliation state. Do not blindly resend after a timeout.' },
    { question: 'Does accepting this policy authorize unsolicited broadcasts?', answer: 'No. Recipient consent, WhatsApp policies, campaign approval and sending limits still apply.' },
  ],
  close: 'Close review',
}
export function getOpenWAPolicyDraftCopy(locale: string): PolicyCopy {
  return locale.toLowerCase().startsWith('ar') ? ar : en
}
