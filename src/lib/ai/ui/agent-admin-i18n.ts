export type AgentAdminUiLocale = 'ar' | 'en'

function lang(locale: string): AgentAdminUiLocale {
  return locale.toLowerCase().startsWith('ar') ? 'ar' : 'en'
}

const TEXT: Record<AgentAdminUiLocale, Record<string, string>> = {
  en: {
    publishBlockedTitle: 'Agent cannot be published yet',
    publishBlockedBody: 'Fix the items below, save the draft, then publish again.',
    validationBlocked: 'Validation found blocking issues.',
    saveRevisionFailed: 'Could not save agent settings.',
    publishFailed: 'Could not publish the agent.',
    actionErrorTitle: 'Action failed',
    apiErrorPrefix: 'Server response',
    country: 'Country / calling code',
    searchCountry: 'Search country or calling code…',
    localNumber: 'Phone number',
    localNumberPlaceholder: 'Enter the number without the country code',
    invalidPhone: 'Enter a valid phone number for the selected country.',
    otpAccepted: 'Verification code request accepted',
    otpAcceptedHint: 'Meta accepted the WhatsApp message for {phone}. Delivery is asynchronous. This code is currently sent as a free-form message, so the recipient must have an open 24-hour customer-service window. If it does not arrive, send any WhatsApp message from that phone to your business number, then resend the code.',
    resendCode: 'Resend code',
    resendHint: 'If the code did not arrive, first message your business WhatsApp number from this phone, then resend.',
    registrationFailed: 'Could not register the trusted admin number.',
    verificationFailed: 'Could not verify the code.',
    revokeFailed: 'Could not revoke the trusted admin number.',
    loadFailed: 'Could not load trusted admin numbers.',
    acceptedByMeta: 'Accepted by Meta',
    verificationSuccess: 'Trusted admin number verified and activated.',
    otpSixDigits: 'Enter the 6-digit verification code.',
    otpExpiresHint: 'The code expires after 10 minutes and is locked after repeated incorrect attempts.',
    continueVerification: 'Enter verification code',
    providerModelHelp: 'Choose the provider connection first, then choose a model from that connection. The saved model remains visible if a provider catalog is temporarily unavailable.',
    selectConnection: 'Choose provider connection',
    selectModel: 'Choose model',
    loadingModels: 'Loading models…',
    noConnections: 'No AI provider connections are available. Configure a connection first.',
    modelCatalogUnavailable: 'Could not load the model catalog for this connection. A previously saved model is preserved, but do not switch models until the catalog loads.',
    savedModelUnavailable: 'This is the model saved on the draft, but it is not present in the provider catalog right now. Verify the provider before publishing.',
    savedModelLabel: 'saved on draft',
    connectionInactive: 'This provider connection is not active. You may save the draft, but publishing will be blocked until the connection is active.',
    connectionRequired: 'Choose a provider connection before saving the agent settings.',
    modelRequiredForSave: 'Choose a model for the selected provider connection before saving.',
    connectionUnavailable: 'The selected provider connection is no longer available in this account. Reload the editor and choose another connection.',
  },
  ar: {
    publishBlockedTitle: 'لا يمكن نشر الوكيل حتى الآن',
    publishBlockedBody: 'أصلح الأسباب الموضحة أدناه، احفظ المسودة، ثم أعد محاولة النشر.',
    validationBlocked: 'وجد الفحص مشاكل تمنع النشر.',
    saveRevisionFailed: 'تعذّر حفظ إعدادات الوكيل.',
    publishFailed: 'تعذّر نشر الوكيل.',
    actionErrorTitle: 'تعذّر تنفيذ العملية',
    apiErrorPrefix: 'رد الخادم',
    country: 'الدولة / رمز الاتصال',
    searchCountry: 'ابحث باسم الدولة أو رمز الاتصال…',
    localNumber: 'رقم الهاتف',
    localNumberPlaceholder: 'اكتب الرقم فقط دون رمز الدولة',
    invalidPhone: 'أدخل رقم هاتف صحيحًا للدولة المحددة.',
    otpAccepted: 'تم قبول طلب إرسال رمز التحقق',
    otpAcceptedHint: 'قبلت Meta رسالة واتساب المرسلة إلى {phone}. التسليم يتم لاحقًا بشكل غير متزامن. رمز التحقق يُرسل حاليًا كرسالة نصية حرة، ولذلك يجب أن تكون نافذة خدمة العملاء لمدة 24 ساعة مفتوحة لهذا الرقم. إذا لم يصل الرمز، أرسل أي رسالة واتساب من هذا الرقم إلى رقم واتساب التجاري لديك، ثم اضغط إعادة إرسال الرمز.',
    resendCode: 'إعادة إرسال الرمز',
    resendHint: 'إذا لم يصل الرمز، أرسل أولًا رسالة من هذا الرقم إلى واتساب التجاري، ثم أعد الإرسال.',
    registrationFailed: 'تعذّر تسجيل الرقم الإداري الموثوق.',
    verificationFailed: 'تعذّر التحقق من الرمز.',
    revokeFailed: 'تعذّر إلغاء الرقم الإداري الموثوق.',
    loadFailed: 'تعذّر تحميل الأرقام الإدارية الموثوقة.',
    acceptedByMeta: 'قبلته Meta',
    verificationSuccess: 'تم التحقق من الرقم الإداري وتفعيله بنجاح.',
    otpSixDigits: 'أدخل رمز التحقق المكوّن من 6 أرقام.',
    otpExpiresHint: 'تنتهي صلاحية الرمز بعد 10 دقائق، ويُقفل بعد تكرار المحاولات الخاطئة.',
    continueVerification: 'إدخال رمز التحقق',
    providerModelHelp: 'اختر اتصال مزود الذكاء الاصطناعي أولًا، ثم اختر نموذجًا من كتالوج ذلك الاتصال. يبقى النموذج المحفوظ ظاهرًا إذا تعذر تحميل الكتالوج مؤقتًا.',
    selectConnection: 'اختر اتصال المزود',
    selectModel: 'اختر النموذج',
    loadingModels: 'جارٍ تحميل النماذج…',
    noConnections: 'لا توجد اتصالات مزود ذكاء اصطناعي متاحة. أضف اتصالًا أولًا.',
    modelCatalogUnavailable: 'تعذّر تحميل كتالوج النماذج لهذا الاتصال. سيبقى النموذج المحفوظ محفوظًا، لكن لا تغيّر النموذج حتى ينجح تحميل الكتالوج.',
    savedModelUnavailable: 'هذا هو النموذج المحفوظ في المسودة لكنه غير موجود حاليًا في كتالوج المزود. تحقّق من المزود قبل النشر.',
    savedModelLabel: 'المحفوظ في المسودة',
    connectionInactive: 'اتصال المزود غير نشط. يمكنك حفظ المسودة، لكن سيُمنع النشر حتى يصبح الاتصال نشطًا.',
    connectionRequired: 'اختر اتصال مزود الذكاء الاصطناعي قبل حفظ إعدادات الوكيل.',
    modelRequiredForSave: 'اختر نموذجًا للاتصال المحدد قبل حفظ إعدادات الوكيل.',
    connectionUnavailable: 'اتصال المزود المحدد لم يعد متاحًا في هذا الحساب. أعد تحميل المحرر واختر اتصالًا آخر.',
  },
}

export function getAgentAdminUiText(locale: string, key: string): string {
  return TEXT[lang(locale)][key] ?? TEXT.en[key] ?? key
}

export interface AgentPublishCheckLike {
  code: string
  message?: string
  path?: string
  severity?: 'error' | 'warning'
}

const CHECKS: Record<AgentAdminUiLocale, Record<string, string>> = {
  en: {
    AGENT_NOT_FOUND: 'The agent no longer exists in this account.',
    REVISION_NOT_FOUND: 'This agent draft could not be found. Reload the page and open the latest draft.',
    AGENT_ARCHIVED: 'Archived agents cannot be published.',
    REVISION_NOT_DRAFT: 'Only a draft revision can be published.',
    PROVIDER_CONNECTION_REQUIRED: 'Choose an AI provider connection before publishing.',
    CONNECTION_NOT_FOUND: 'The selected AI provider connection no longer exists in this account.',
    CONNECTION_NOT_ACTIVE: 'The selected AI provider connection is not active. Test or repair the connection before publishing.',
    MODEL_REQUIRED: 'Choose a model before publishing.',
    TOOLS_REQUIRED: 'Tool rounds are enabled but this draft has no granted tools. Grant at least one tool or set tool rounds to 0.',
    INVALID_TOOL_ROUNDS: 'Tool rounds cannot be negative.',
    UNKNOWN_TOOL: 'One of the granted tools is no longer registered. Re-save the tool permissions.',
    STALE_TOOL_VERSION: 'One of the granted tools uses an old version. Re-save the tool permissions to use the current version.',
    PERMISSION_NOT_ALLOWED: 'One of the selected tool permissions is not allowed. Review and save the tool permissions again.',
    DOUBLE_DEFAULT: 'There is more than one active default route for the same channel. Keep only one default route.',
    ADMIN_WITHOUT_TRUSTED_IDENTITY: 'The admin agent cannot be published until at least one trusted admin WhatsApp number is verified and ACTIVE. Register the number, receive the OTP, verify it, then publish again.',
    INDETERMINATE_TIE: 'Two routing rules have the same priority and identical conditions. Change the priority or conditions of one rule.',
    SHADOWED_RULE: 'A higher-priority routing rule hides another rule. Review the route priorities.',
    NO_BUDGET_POLICY: 'No active budget policy is configured; account defaults will be used.',
    PAUSED_TARGET: 'A route points to a paused agent; matching messages will fall through to humans.',
  },
  ar: {
    AGENT_NOT_FOUND: 'هذا الوكيل لم يعد موجودًا في الحساب.',
    REVISION_NOT_FOUND: 'تعذّر العثور على مسودة الوكيل. حدّث الصفحة وافتح أحدث مسودة.',
    AGENT_ARCHIVED: 'لا يمكن نشر وكيل مؤرشف.',
    REVISION_NOT_DRAFT: 'لا يمكن نشر إلا نسخة بحالة مسودة.',
    PROVIDER_CONNECTION_REQUIRED: 'اختر اتصال مزود ذكاء اصطناعي قبل النشر.',
    CONNECTION_NOT_FOUND: 'اتصال مزود الذكاء الاصطناعي المحدد لم يعد موجودًا في هذا الحساب.',
    CONNECTION_NOT_ACTIVE: 'اتصال مزود الذكاء الاصطناعي المحدد غير نشط. اختبر الاتصال أو أصلحه قبل النشر.',
    MODEL_REQUIRED: 'اختر نموذج الذكاء الاصطناعي قبل النشر.',
    TOOLS_REQUIRED: 'جولات الأدوات مفعّلة لكن المسودة لا تملك أي أدوات مسموحة. امنح أداة واحدة على الأقل أو اجعل جولات الأدوات 0.',
    INVALID_TOOL_ROUNDS: 'عدد جولات الأدوات لا يمكن أن يكون سالبًا.',
    UNKNOWN_TOOL: 'إحدى الأدوات الممنوحة لم تعد مسجلة. راجع قسم الأدوات واحفظ الصلاحيات من جديد.',
    STALE_TOOL_VERSION: 'إحدى الأدوات تستخدم إصدارًا قديمًا. أعد حفظ صلاحيات الأدوات لاستخدام الإصدار الحالي.',
    PERMISSION_NOT_ALLOWED: 'إحدى صلاحيات الأدوات المحددة غير مسموحة. راجع الأدوات واحفظها من جديد.',
    DOUBLE_DEFAULT: 'يوجد أكثر من مسار افتراضي نشط للقناة نفسها. أبقِ مسارًا افتراضيًا واحدًا فقط.',
    ADMIN_WITHOUT_TRUSTED_IDENTITY: 'لا يمكن نشر وكيل الإدارة قبل وجود رقم واتساب إداري موثوق واحد على الأقل بحالة «نشط». سجّل الرقم، استلم رمز التحقق، فعّل الرقم، ثم أعد نشر الوكيل.',
    INDETERMINATE_TIE: 'قاعدتا توجيه لهما نفس الأولوية ونفس الشروط. غيّر أولوية أو شروط إحدى القاعدتين.',
    SHADOWED_RULE: 'قاعدة توجيه ذات أولوية أعلى تحجب قاعدة أخرى. راجع أولويات التوجيه.',
    NO_BUDGET_POLICY: 'لا توجد سياسة ميزانية نشطة؛ ستُستخدم الإعدادات الافتراضية للحساب.',
    PAUSED_TARGET: 'أحد المسارات يشير إلى وكيل متوقف؛ الرسائل المطابقة ستنتقل إلى البشر.',
  },
}

export function localizePublishCheck(locale: string, check: AgentPublishCheckLike): string {
  const language = lang(locale)
  return CHECKS[language][check.code] ?? check.message ?? check.code
}


const AGENT_API_ERRORS: Record<AgentAdminUiLocale, Record<string, string>> = {
  en: {
    SYSTEM_PROMPT_TOO_LONG: 'The system instructions are too long (maximum 8,000 characters).',
    INVALID_RESPONSE_STYLE: 'Choose a valid response style.',
    INVALID_LANGUAGE_POLICY: 'Choose a valid reply language policy.',
    INVALID_TEMPERATURE: 'Temperature must be between 0 and 2.',
    INVALID_MAX_OUTPUT_TOKENS: 'Maximum output tokens must be between 16 and 32,000.',
    INVALID_MAX_TOOL_ROUNDS: 'Tool rounds must be between 0 and 10.',
    INVALID_REPLY_CAP: 'Maximum AI replies per conversation must be between 1 and 20.',
    NO_FIELDS_SUPPLIED: 'No agent settings were supplied to save.',
    REVISION_NOT_DRAFT: 'This revision is no longer a draft. Reload the agent editor.',
    PROVIDER_CONNECTION_REQUIRED: 'Choose an AI provider connection before saving.',
    MODEL_REQUIRED: 'Choose a model before saving.',
    CONNECTION_NOT_FOUND: 'The selected AI provider connection does not belong to this account or no longer exists.',
  },
  ar: {
    SYSTEM_PROMPT_TOO_LONG: 'التعليمات الأساسية طويلة جدًا؛ الحد الأقصى 8,000 حرف.',
    INVALID_RESPONSE_STYLE: 'اختر أسلوب رد صحيحًا.',
    INVALID_LANGUAGE_POLICY: 'اختر سياسة لغة رد صحيحة.',
    INVALID_TEMPERATURE: 'يجب أن تكون الحرارة بين 0 و2.',
    INVALID_MAX_OUTPUT_TOKENS: 'يجب أن يكون حد رموز الإخراج بين 16 و32,000.',
    INVALID_MAX_TOOL_ROUNDS: 'يجب أن يكون عدد جولات الأدوات بين 0 و10.',
    INVALID_REPLY_CAP: 'يجب أن يكون سقف ردود الذكاء الاصطناعي لكل محادثة بين 1 و20.',
    NO_FIELDS_SUPPLIED: 'لم تُرسل أي إعدادات للوكيل ليتم حفظها.',
    REVISION_NOT_DRAFT: 'هذه النسخة لم تعد مسودة. حدّث محرر الوكيل.',
    PROVIDER_CONNECTION_REQUIRED: 'اختر اتصال مزود ذكاء اصطناعي قبل الحفظ.',
    MODEL_REQUIRED: 'اختر نموذجًا قبل الحفظ.',
    CONNECTION_NOT_FOUND: 'اتصال مزود الذكاء الاصطناعي المحدد لا ينتمي لهذا الحساب أو لم يعد موجودًا.',
  },
}

export function localizeAgentApiError(locale: string, code?: string, fallback?: string): string {
  if (code) {
    const translated = AGENT_API_ERRORS[lang(locale)][code]
    if (translated) return translated
  }
  return fallback || getAgentAdminUiText(locale, 'actionErrorTitle')
}

const TRUSTED_ADMIN_ERRORS: Record<AgentAdminUiLocale, Record<string, string>> = {
  en: {
    INVALID_PHONE: 'The phone number is not valid for WhatsApp/E.164.',
    REGISTER_FAILED: 'The trusted admin number could not be registered.',
    INVALID_OTP_FORMAT: 'The verification code must contain digits only.',
    IDENTITY_NOT_FOUND: 'The trusted admin number was not found.',
    IDENTITY_REVOKED: 'This number was revoked. Register it again to request a new code.',
    NO_PENDING_OTP: 'There is no pending verification code for this number. Request a new one.',
    OTP_EXPIRED: 'The verification code expired. Request a new one.',
    OTP_TOO_MANY_ATTEMPTS: 'Too many incorrect attempts. Request a new verification code.',
    OTP_MISMATCH: 'The verification code is incorrect.',
    VERIFY_CONFLICT: 'The verification state changed. Reload and try again.',
    VERIFY_FAILED: 'The verification request could not be completed.',
    TRUSTED_ADMIN_CRYPTO_UNAVAILABLE: 'Trusted-admin verification is not ready in the database. Apply migration 068, then retry.',
  },
  ar: {
    INVALID_PHONE: 'رقم الهاتف غير صالح لواتساب أو لتنسيق E.164.',
    REGISTER_FAILED: 'تعذّر تسجيل الرقم الإداري الموثوق.',
    INVALID_OTP_FORMAT: 'يجب أن يحتوي رمز التحقق على أرقام فقط.',
    IDENTITY_NOT_FOUND: 'لم يتم العثور على الرقم الإداري الموثوق.',
    IDENTITY_REVOKED: 'تم إلغاء هذا الرقم. سجّله من جديد لطلب رمز جديد.',
    NO_PENDING_OTP: 'لا يوجد رمز تحقق معلّق لهذا الرقم. اطلب رمزًا جديدًا.',
    OTP_EXPIRED: 'انتهت صلاحية رمز التحقق. اطلب رمزًا جديدًا.',
    OTP_TOO_MANY_ATTEMPTS: 'محاولات خاطئة كثيرة. اطلب رمز تحقق جديدًا.',
    OTP_MISMATCH: 'رمز التحقق غير صحيح.',
    VERIFY_CONFLICT: 'تغيرت حالة التحقق. حدّث الصفحة وحاول مرة أخرى.',
    VERIFY_FAILED: 'تعذّر إكمال عملية التحقق.',
    TRUSTED_ADMIN_CRYPTO_UNAVAILABLE: 'التحقق من الأرقام الإدارية غير جاهز في قاعدة البيانات. طبّق migration 068 ثم أعد المحاولة.',
  },
}

export function localizeTrustedAdminError(locale: string, code?: string, fallback?: string): string {
  if (code) {
    const translated = TRUSTED_ADMIN_ERRORS[lang(locale)][code]
    if (translated) return translated
  }
  return fallback || getAgentAdminUiText(locale, 'registrationFailed')
}

export function formatLocalized(locale: string, text: string, values: Record<string, string>): string {
  let output = text
  for (const [key, value] of Object.entries(values)) output = output.replaceAll(`{${key}}`, value)
  return output
}
