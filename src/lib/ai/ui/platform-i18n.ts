export type AiUiLocale = 'ar' | 'en'

function pickLocale(locale: string): AiUiLocale {
  return locale.toLowerCase().startsWith('ar') ? 'ar' : 'en'
}

interface ToolText {
  label: string
  description: string
}

const TOOL_TEXT: Record<AiUiLocale, Record<string, ToolText>> = {
  en: {
    'services.search': { label: 'Search services', description: 'Search the active services catalog by name, code, or category.' },
    'services.get': { label: 'Read service details', description: 'Read one service and its public fields by ID or code.' },
    'services.match_request': { label: 'Match a service request', description: 'Match a customer request to configured services and identify missing fields.' },
    'services.propose_update': { label: 'Propose service update', description: 'Create an admin proposal to update approved service data. It does not write directly.' },
    'pricing.calculate_quote': { label: 'Calculate price quote', description: 'Calculate a quote from the published pricing rules without changing data.' },
    'pricing_rules.propose_service_price': { label: 'Propose service price', description: 'Create an admin proposal for a new service pricing rule and attachment.' },
    'exchange_rates.get_current': { label: 'Read current exchange rate', description: 'Read the current published exchange rate for a currency pair and context.' },
    'exchange_rates.record_trade_request': { label: 'Record currency trade request', description: 'Record a customer request to buy or sell currency. It never changes exchange rates.' },
    'exchange_rates.admin_list_pairs': { label: 'List FX pairs', description: 'Read pair-centric FX V2 rates, current version data, and optimistic lock versions for administration.' },
    'exchange_rates.admin_list_trade_requests': { label: 'List FX trade requests', description: 'Read customer FX V2 trade requests and their current lifecycle state for administration.' },
    'exchange_rates.propose_pair_change': { label: 'Propose FX rate change', description: 'Create an approval-bound FX V2 pair-rate proposal using the expected lock version.' },
    'exchange_rates.propose_trade_decision': { label: 'Propose FX trade decision', description: 'Create an approval-bound proposal to approve-for-contact or reject a pending FX trade request.' },
    'coverage.check_availability': { label: 'Check coverage availability', description: 'Check aggregate coverage availability without exposing provider identity.' },
    'coverage.find_offers': { label: 'Find coverage offers', description: 'Find active, anonymized coverage offers that match the requested amount and route.' },
    'coverage.get_rates': { label: 'Read coverage commission rates', description: 'Read the current published coverage commission board.' },
    'coverage.propose_offer': { label: 'Submit customer coverage offer', description: 'Forward the current customer’s coverage offer for admin review and approval.' },
    'coverage.propose_request': { label: 'Submit customer coverage request', description: 'Forward the current customer’s coverage request for admin review and approval.' },
    'coverage.admin_list_offers': { label: 'List coverage offers', description: 'Read coverage offers for the administrative plane.' },
    'coverage.admin_list_requests': { label: 'List coverage requests', description: 'Read coverage requests for the administrative plane.' },
    'intents.record': { label: 'Record customer intent', description: 'Record a structured customer need or offer and optionally forward it to administration.' },
    'intents.search': { label: 'Search customer intents', description: 'Search recorded customer intents by contact, status, or text.' },
    'intents.propose_decision': { label: 'Propose intent decision', description: 'Create an administrative decision proposal for a pending customer intent.' },
    'change_requests.list_pending': { label: 'List pending changes', description: 'Read pending change requests that require administrative handling or approval.' },
  },
  ar: {
    'services.search': { label: 'البحث في الخدمات', description: 'البحث في كتالوج الخدمات النشطة بالاسم أو الرمز أو التصنيف.' },
    'services.get': { label: 'قراءة تفاصيل خدمة', description: 'قراءة خدمة واحدة وحقولها العامة باستخدام المعرّف أو الرمز.' },
    'services.match_request': { label: 'مطابقة طلب مع خدمة', description: 'مطابقة طلب العميل مع الخدمات المهيأة وتحديد البيانات الناقصة.' },
    'services.propose_update': { label: 'اقتراح تحديث خدمة', description: 'إنشاء اقتراح إداري لتحديث بيانات خدمة معتمدة دون كتابة مباشرة.' },
    'pricing.calculate_quote': { label: 'حساب عرض سعر', description: 'حساب التسعير من قواعد التسعير المنشورة دون تعديل البيانات.' },
    'pricing_rules.propose_service_price': { label: 'اقتراح تسعير خدمة', description: 'إنشاء اقتراح إداري لقاعدة تسعير جديدة وربطها بالخدمة.' },
    'exchange_rates.get_current': { label: 'قراءة سعر الصرف الحالي', description: 'قراءة سعر الصرف المنشور حاليًا لزوج العملات والسياق المحدد.' },
    'exchange_rates.record_trade_request': { label: 'تسجيل طلب شراء أو بيع عملة', description: 'تسجيل طلب العميل لشراء أو بيع عملة فقط، دون أي صلاحية لتغيير أسعار الصرف.' },
    'exchange_rates.admin_list_pairs': { label: 'عرض أزواج الصرف', description: 'قراءة أزواج FX V2 وأسعارها الحالية وإصداراتها ونسخة القفل المتفائل للإدارة.' },
    'exchange_rates.admin_list_trade_requests': { label: 'عرض طلبات الصرف', description: 'قراءة طلبات صرف العملاء في FX V2 وحالتها التشغيلية الحالية للإدارة.' },
    'exchange_rates.propose_pair_change': { label: 'اقتراح تغيير سعر صرف', description: 'إنشاء اقتراح FX V2 خاضع للاعتماد لتغيير سعر زوج مع حماية نسخة القفل المتوقعة.' },
    'exchange_rates.propose_trade_decision': { label: 'اقتراح قرار لطلب صرف', description: 'إنشاء اقتراح خاضع للاعتماد لقبول طلب صرف معلّق للتواصل أو رفضه.' },
    'coverage.check_availability': { label: 'التحقق من توفر التغطية', description: 'فحص توفر التغطية بشكل تجميعي دون كشف هوية مقدم التغطية.' },
    'coverage.find_offers': { label: 'البحث عن عروض تغطية', description: 'البحث في عروض التغطية النشطة والمجهولة المطابقة للمبلغ والمسار المطلوب.' },
    'coverage.get_rates': { label: 'قراءة أسعار عمولات التغطية', description: 'قراءة لوحة عمولات التغطية المنشورة حاليًا.' },
    'coverage.propose_offer': { label: 'إرسال عرض تغطية من العميل', description: 'رفع عرض التغطية المقدم من العميل الحالي إلى الإدارة للمراجعة والاعتماد.' },
    'coverage.propose_request': { label: 'إرسال طلب تغطية من العميل', description: 'رفع طلب التغطية المقدم من العميل الحالي إلى الإدارة للمراجعة والاعتماد.' },
    'coverage.admin_list_offers': { label: 'عرض عروض التغطية', description: 'قراءة عروض التغطية ضمن المستوى الإداري.' },
    'coverage.admin_list_requests': { label: 'عرض طلبات التغطية', description: 'قراءة طلبات التغطية ضمن المستوى الإداري.' },
    'intents.record': { label: 'تسجيل نية العميل', description: 'تسجيل حاجة أو عرض من العميل بصورة منظمة مع إمكانية إحالته إلى الإدارة.' },
    'intents.search': { label: 'البحث في نوايا العملاء', description: 'البحث في نوايا العملاء المسجلة حسب العميل أو الحالة أو النص.' },
    'intents.propose_decision': { label: 'اقتراح قرار بشأن نية عميل', description: 'إنشاء اقتراح قرار إداري لنية عميل معلقة.' },
    'change_requests.list_pending': { label: 'عرض طلبات التغيير المعلقة', description: 'قراءة طلبات التغيير التي ما زالت تحتاج معالجة أو اعتمادًا إداريًا.' },
  },
}

const CATEGORY_TEXT: Record<AiUiLocale, Record<string, string>> = {
  en: { services: 'Services', pricing: 'Pricing', rates: 'Exchange rates', coverage: 'Coverage', intents: 'Customer intents', changes: 'Change requests' },
  ar: { services: 'الخدمات', pricing: 'التسعير', rates: 'أسعار الصرف', coverage: 'التغطيات', intents: 'نوايا العملاء', changes: 'طلبات التغيير' },
}

const PERMISSION_TEXT: Record<AiUiLocale, Record<string, string>> = {
  en: { read: 'Read', propose: 'Propose', execute: 'Execute' },
  ar: { read: 'قراءة', propose: 'اقتراح', execute: 'تنفيذ' },
}

export function getToolUiText(locale: string, toolKey: string, fallbackDescription: string): ToolText {
  const lang = pickLocale(locale)
  return TOOL_TEXT[lang][toolKey] ?? {
    label: toolKey,
    description: fallbackDescription,
  }
}

export function getToolCategoryLabel(locale: string, category: string): string {
  const lang = pickLocale(locale)
  return CATEGORY_TEXT[lang][category] ?? category
}

export function getToolPermissionLabel(locale: string, permission: string): string {
  const lang = pickLocale(locale)
  return PERMISSION_TEXT[lang][permission] ?? permission
}

const KNOWLEDGE_ENUMS: Record<AiUiLocale, Record<string, Record<string, string>>> = {
  en: {
    scope: { shared: 'Shared', agent_private: 'Agent-private', service: 'Service-linked' },
    baseStatus: { draft: 'Draft', active: 'Active', archived: 'Archived' },
    documentStatus: { draft: 'Draft', reviewed: 'Reviewed', active: 'Active', superseded: 'Superseded', archived: 'Archived', quarantined: 'Quarantined' },
    trust: { admin_verified: 'Admin verified', internal: 'Internal', external: 'External', untrusted: 'Untrusted' },
    injectionRisk: { none: 'None', suspected: 'Suspected', high: 'High' },
    sourceType: { manual: 'Manual', import: 'Imported', api: 'API', legacy: 'Legacy' },
    language: { auto: 'Auto', ar: 'Arabic', en: 'English', ko: 'Korean' },
  },
  ar: {
    scope: { shared: 'مشتركة', agent_private: 'خاصة بالوكيل', service: 'مرتبطة بخدمة' },
    baseStatus: { draft: 'مسودة', active: 'نشطة', archived: 'مؤرشفة' },
    documentStatus: { draft: 'مسودة', reviewed: 'تمت المراجعة', active: 'نشط', superseded: 'مستبدل بإصدار أحدث', archived: 'مؤرشف', quarantined: 'معزول للمراجعة' },
    trust: { admin_verified: 'موثّق من الإدارة', internal: 'داخلي', external: 'خارجي', untrusted: 'غير موثوق' },
    injectionRisk: { none: 'لا يوجد', suspected: 'مشتبه به', high: 'مرتفع' },
    sourceType: { manual: 'يدوي', import: 'مستورد', api: 'واجهة API', legacy: 'قديم/مرحّل' },
    language: { auto: 'تلقائي', ar: 'العربية', en: 'الإنجليزية', ko: 'الكورية' },
  },
}

export function getKnowledgeEnumLabel(
  locale: string,
  group: 'scope' | 'baseStatus' | 'documentStatus' | 'trust' | 'injectionRisk' | 'sourceType' | 'language',
  value: string,
): string {
  const lang = pickLocale(locale)
  return KNOWLEDGE_ENUMS[lang][group][value] ?? value
}

const KB_UI_TEXT: Record<AiUiLocale, Record<string, string>> = {
  en: {
    platformDescription: 'Dynamic knowledge bases. Agents use only bases explicitly assigned to their published revision.',
    bases: 'Knowledge bases',
    new: 'New',
    baseName: 'Knowledge base name',
    optionalDescription: 'Description (optional)',
    createDraft: 'Create draft',
    noBases: 'No knowledge bases yet.',
    selectBase: 'Select a knowledge base.',
    noDescription: 'No description',
    activateBase: 'Activate base',
    archiveBase: 'Archive base',
    documents: 'Documents',
    reindex: 'Reindex',
    addDocument: 'Add document',
    title: 'Title',
    content: 'Content',
    newContentSafety: 'New content is never active automatically. Injection-like text may be quarantined for review.',
    saveDraft: 'Save draft',
    noDocuments: 'No documents in this base.',
    injectionRisk: 'Injection risk',
    reviewNotesRequired: 'Review notes required for high-risk content',
    reviewNotesOptional: 'Review notes (optional)',
    review: 'Review',
    activate: 'Activate',
    archive: 'Archive',
    baseCreated: 'Knowledge base created as draft',
    baseStatusChanged: 'Knowledge base is now {status}',
    docQuarantined: 'Document was quarantined for review',
    docSavedDraft: 'Document saved as draft; review and activate it before agents can use it',
    docStatusChanged: 'Document is now {status}',
    privateTitle: 'Agent-private knowledge',
    privateDescription: 'Create a dynamic knowledge base owned by this agent. It cannot be assigned to another agent.',
    privateName: 'Private knowledge base name',
    create: 'Create',
    privateCreated: 'Private knowledge base created as draft. Add and review its documents, activate it, then assign it to a draft revision.',
    privateCreateFailed: 'Failed to create private knowledge base',
    assignmentsFrozen: 'Knowledge assignments are frozen on a published revision. Create or edit a draft revision to change them.',
  },
  ar: {
    platformDescription: 'قواعد معرفة ديناميكية. لا يستخدم الوكيل إلا القواعد المسندة صراحةً إلى نسخته المنشورة.',
    bases: 'قواعد المعرفة',
    new: 'جديدة',
    baseName: 'اسم قاعدة المعرفة',
    optionalDescription: 'الوصف (اختياري)',
    createDraft: 'إنشاء كمسودة',
    noBases: 'لا توجد قواعد معرفة بعد.',
    selectBase: 'اختر قاعدة معرفة.',
    noDescription: 'لا يوجد وصف',
    activateBase: 'تفعيل القاعدة',
    archiveBase: 'أرشفة القاعدة',
    documents: 'المستندات',
    reindex: 'إعادة الفهرسة',
    addDocument: 'إضافة مستند',
    title: 'العنوان',
    content: 'المحتوى',
    newContentSafety: 'لا يصبح المحتوى الجديد نشطًا تلقائيًا. قد يُعزل النص المشابه لحقن التعليمات حتى تتم مراجعته.',
    saveDraft: 'حفظ كمسودة',
    noDocuments: 'لا توجد مستندات في هذه القاعدة.',
    injectionRisk: 'مخاطر حقن التعليمات',
    reviewNotesRequired: 'ملاحظات المراجع مطلوبة للمحتوى عالي الخطورة',
    reviewNotesOptional: 'ملاحظات المراجعة (اختياري)',
    review: 'مراجعة',
    activate: 'تفعيل',
    archive: 'أرشفة',
    baseCreated: 'تم إنشاء قاعدة المعرفة كمسودة',
    baseStatusChanged: 'أصبحت حالة قاعدة المعرفة: {status}',
    docQuarantined: 'تم عزل المستند للمراجعة بسبب ارتفاع مخاطر حقن التعليمات',
    docSavedDraft: 'تم حفظ المستند كمسودة؛ راجعه ثم فعّله قبل أن يتمكن الوكلاء من استخدامه',
    docStatusChanged: 'أصبحت حالة المستند: {status}',
    privateTitle: 'معرفة خاصة بالوكيل',
    privateDescription: 'أنشئ قاعدة معرفة ديناميكية مملوكة لهذا الوكيل، ولا يمكن إسنادها إلى وكيل آخر.',
    privateName: 'اسم قاعدة المعرفة الخاصة',
    create: 'إنشاء',
    privateCreated: 'تم إنشاء قاعدة المعرفة الخاصة كمسودة. أضف مستنداتها وراجعها وفعّل القاعدة، ثم أسندها إلى نسخة مسودة من الوكيل.',
    privateCreateFailed: 'تعذّر إنشاء قاعدة المعرفة الخاصة',
    assignmentsFrozen: 'إسنادات المعرفة ثابتة في النسخة المنشورة. أنشئ نسخة مسودة أو حررها لتغيير الإسنادات.',
  },
}

export function getKnowledgeUiText(locale: string, key: string, values?: Record<string, string>): string {
  const lang = pickLocale(locale)
  let text = KB_UI_TEXT[lang][key] ?? KB_UI_TEXT.en[key] ?? key
  for (const [name, value] of Object.entries(values ?? {})) {
    text = text.replace(`{${name}}`, value)
  }
  return text
}
