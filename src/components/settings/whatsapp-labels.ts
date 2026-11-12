import { useLocale } from 'next-intl'

const labels = {
  "metaTitle": {
    "en": "Meta Cloud API",
    "ar": "واجهة Meta Cloud API"
  },
  "metaDesc": {
    "en": "Official/default production WhatsApp provider. Existing Meta behavior remains unchanged.",
    "ar": "مزود واتساب الرسمي والافتراضي للإنتاج. سيظل سلوك Meta الحالي دون تغيير."
  },
  "connection": {
    "en": "Connection:",
    "ar": "حالة الاتصال:"
  },
  "connected": {
    "en": "Connected",
    "ar": "متصل"
  },
  "disconnected": {
    "en": "Disconnected",
    "ar": "غير متصل"
  },
  "unknown": {
    "en": "Unknown",
    "ar": "غير معروف"
  },
  "phone": {
    "en": "Phone Number ID",
    "ar": "معرّف رقم الهاتف"
  },
  "waba": {
    "en": "WABA ID",
    "ar": "معرّف حساب واتساب للأعمال"
  },
  "access": {
    "en": "Access Token",
    "ar": "رمز الوصول"
  },
  "verify": {
    "en": "Verify Token",
    "ar": "رمز التحقق"
  },
  "pin": {
    "en": "Two-step PIN (optional)",
    "ar": "رمز التحقق بخطوتين (اختياري)"
  },
  "save": {
    "en": "Save Meta configuration",
    "ar": "حفظ إعدادات Meta"
  },
  "test": {
    "en": "Test Meta connection",
    "ar": "اختبار اتصال Meta"
  },
  "scope": {
    "en": "Meta configuration is account-scoped. Sensitive tokens are encrypted server-side.",
    "ar": "إعدادات Meta مخصصة لهذا الحساب. تُشفّر الرموز الحساسة على الخادم."
  },
  "loadMeta": {
    "en": "Failed to load WhatsApp configuration",
    "ar": "تعذّر تحميل إعدادات واتساب"
  },
  "admin": {
    "en": "Admin access is required",
    "ar": "يلزم امتلاك صلاحية المسؤول"
  },
  "phoneRequired": {
    "en": "Phone Number ID is required",
    "ar": "معرّف رقم الهاتف مطلوب"
  },
  "tokenRequired": {
    "en": "Please enter the Access Token to save Meta Cloud settings",
    "ar": "يرجى إدخال رمز الوصول لحفظ إعدادات Meta Cloud"
  },
  "saveFailed": {
    "en": "Failed to save configuration",
    "ar": "تعذّر حفظ الإعدادات"
  },
  "savedAttention": {
    "en": "Meta credentials saved; registration still needs attention.",
    "ar": "حُفظت بيانات اعتماد Meta، لكن التسجيل يحتاج إلى مراجعة."
  },
  "saved": {
    "en": "Meta Cloud configuration saved.",
    "ar": "تم حفظ إعدادات Meta Cloud."
  },
  "testSuccess": {
    "en": "Meta Cloud API connection successful",
    "ar": "نجح الاتصال بواجهة Meta Cloud API"
  },
  "testFailed": {
    "en": "Meta Cloud API connection failed",
    "ar": "فشل الاتصال بواجهة Meta Cloud API"
  },
  "openwaDesc": {
    "en": "Optional self-hosted transport. Meta Cloud remains the default production provider.",
    "ar": "وسيلة اتصال اختيارية تستضيفها بنفسك. تظل Meta Cloud المزود الافتراضي للإنتاج."
  },
  "onboarding": {
    "en": "Admin-only onboarding",
    "ar": "الإعداد متاح للمسؤولين فقط"
  },
  "onboardingDesc": {
    "en": "The API key is encrypted server-side. QR material is never stored by WACRM and expires quickly.",
    "ar": "يُشفّر مفتاح API على الخادم. لا يخزّن WACRM بيانات رمز QR وتنتهي صلاحيتها سريعًا."
  },
  "name": {
    "en": "Name",
    "ar": "الاسم"
  },
  "engine": {
    "en": "Engine",
    "ar": "المحرّك"
  },
  "baseUrl": {
    "en": "OpenWA HTTPS URL (ngrok)",
    "ar": "رابط OpenWA الآمن (ngrok)"
  },
  "apiKey": {
    "en": "API key",
    "ar": "مفتاح API"
  },
  "create": {
    "en": "Create WhatsApp Web session",
    "ar": "إنشاء جلسة واتساب ويب"
  },
  "gatewayCheck": {
    "en": "Test OpenWA connection",
    "ar": "اختبار اتصال OpenWA"
  },
  "sendViaOpenwa": {
    "en": "Send via OpenWA",
    "ar": "الإرسال عبر OpenWA"
  },
  "conversationConnectionAutomatic": {
    "en": "Conversation connection",
    "ar": "اتصال المحادثة"
  },
  "conversationConnectionAlternative": {
    "en": "Select a connected session",
    "ar": "اختر جلسة متصلة"
  },
  "conversationConnectionCaution": {
    "en": "Choose a current connection only after checking the gateway; existing messages keep their original session.",
    "ar": "اختر اتصالاً حاليًا بعد التحقق من الخدمة؛ الرسائل القديمة تبقى مرتبطة بجلستها الأصلية."
  },
  "gatewayCheckSuccess": {
    "en": "OpenWA gateway connection and API authentication succeeded",
    "ar": "نجح الاتصال بخدمة OpenWA والمصادقة عبر API"
  },
  "gatewayCheckFailed": {
    "en": "OpenWA gateway connection test failed",
    "ar": "فشل اختبار الاتصال بخدمة OpenWA"
  },
  "quickTunnelWarning": {
    "en": "Cloudflare Quick Tunnel links are temporary. After restarting the tunnel, confirm the current URL and test the gateway before creating a new session.",
    "ar": "روابط Cloudflare Quick Tunnel مؤقتة. بعد إعادة تشغيل النفق تأكد من الرابط الحالي واختبر الخدمة قبل إنشاء جلسة جديدة."
  },
  "status": {
    "en": "Status:",
    "ar": "الحالة:"
  },
  "refresh": {
    "en": "Refresh",
    "ar": "تحديث"
  },
  "showQr": {
    "en": "Show QR",
    "ar": "عرض رمز QR"
  },
  "reconnect": {
    "en": "Reconnect",
    "ar": "إعادة الاتصال"
  },
  "logout": {
    "en": "Log out",
    "ar": "تسجيل الخروج"
  },
  "reconciliationTitle": {
    "en": "OpenWA session needs verification",
    "ar": "تحتاج جلسة OpenWA إلى التحقق"
  },
  "reconciliationDesc": {
    "en": "A previous session start was uncertain. If the gateway is ready, click Refresh to verify this session and clear the warning. Do not create another session.",
    "ar": "كانت نتيجة بدء الجلسة السابقة غير مؤكدة. إذا كانت الجلسة جاهزة في OpenWA، اضغط تحديث للتحقق منها وإزالة التحذير. لا تنشئ جلسة جديدة."
  },
  "duplicatePhoneNotice": {
    "en": "Multiple WACRM connections show this number. Check their session IDs and pending messages before removing a connection.",
    "ar": "توجد عدة اتصالات في WACRM لهذا الرقم. تحقق من معرّفات الجلسات والرسائل المعلّقة قبل حذف أي اتصال."
  },
  "connectionReference": {
    "en": "WACRM connection",
    "ar": "معرّف اتصال WACRM"
  },
  "removeFromWacrm": {
    "en": "Remove from WACRM",
    "ar": "حذف من WACRM"
  },
  "removeSessionTitle": {
    "en": "Remove this OpenWA session?",
    "ar": "هل تريد حذف جلسة OpenWA؟"
  },
  "removeSessionWarning": {
    "en": "The session will disappear from WACRM and its stored API/webhook keys will be revoked. Existing messages, delivery receipts and audit records will be retained. This does NOT stop or delete the session on the OpenWA server; log out separately if needed. Pending sends or unprocessed webhooks block removal.",
    "ar": "ستختفي الجلسة من WACRM وتُحذف مفاتيح API وWebhook المخزنة لها. ستبقى الرسائل القديمة وإشعارات حالتها وسجلات التدقيق محفوظة. لن يؤدي ذلك إلى إيقاف الجلسة أو حذفها من خادم OpenWA؛ سجّل الخروج بصورة منفصلة إذا لزم. تُمنع الإزالة في حال وجود رسائل معلّقة أو Webhooks لم تكتمل معالجتها."
  },
  "removeSessionConfirm": {
    "en": "Confirm removal",
    "ar": "تأكيد الحذف"
  },
  "removeSessionCancel": {
    "en": "Cancel",
    "ar": "إلغاء"
  },
  "removeSessionSuccess": {
    "en": "OpenWA session removed from WACRM. Message history was preserved.",
    "ar": "حُذفت جلسة OpenWA من WACRM مع الحفاظ على سجل الرسائل."
  },
  "removeSessionFailed": {
    "en": "Could not remove OpenWA session",
    "ar": "تعذّر حذف جلسة OpenWA"
  },

  "qrPayload": {
    "en": "Short-lived QR payload",
    "ar": "بيانات رمز QR مؤقتة"
  },
  "expires": {
    "en": "Expires",
    "ar": "تنتهي الصلاحية عند"
  },
  "qrHint": {
    "en": "Refresh if your WhatsApp client cannot scan it.",
    "ar": "حدّث الرمز إذا تعذّر مسحه بتطبيق واتساب."
  },
  "loadOpenwa": {
    "en": "Failed to load WhatsApp Web connections",
    "ar": "تعذّر تحميل اتصالات واتساب ويب"
  },
  "required": {
    "en": "OpenWA URL and API key are required",
    "ar": "رابط OpenWA ومفتاح API مطلوبان"
  },
  "createFailed": {
    "en": "Failed to create WhatsApp Web session",
    "ar": "تعذّر إنشاء جلسة واتساب ويب"
  },
  "created": {
    "en": "WhatsApp Web session created. Scan its QR code to authenticate.",
    "ar": "تم إنشاء جلسة واتساب ويب. امسح رمز QR لتسجيل الدخول."
  },
  "qrUnavailable": {
    "en": "QR is not available",
    "ar": "رمز QR غير متاح"
  },
  "configureWebhook": {
    "en": "Enable signed webhooks",
    "ar": "تفعيل Webhooks الموقّعة"
  },
  "webhookConfigured": {
    "en": "OpenWA webhook configured successfully",
    "ar": "تم إعداد Webhook الخاص بـOpenWA بنجاح"
  },
  "pilotEnforceOn": {
    "en": "Pilot allowlist enforcement: ON",
    "ar": "فرض قائمة سماح Pilot: مفعّل"
  },
  "pilotEnforceOff": {
    "en": "Pilot allowlist enforcement: OFF",
    "ar": "فرض قائمة سماح Pilot: غير مفعّل"
  },
  "pilotEnforceOnHint": {
    "en": "All OpenWA sends on this WACRM instance require server-authorized recipient and workload grants. The stop switch still applies. This does not automatically start a pilot.",
    "ar": "تتطلب جميع عمليات الإرسال عبر OpenWA في هذه النسخة موافقة المستلم ونوع العمل على الخادم. يظل مفتاح الإيقاف ساريًا. هذا لا يبدأ التجربة تلقائيًا."
  },
  "pilotEnforceOffHint": {
    "en": "The pilot recipient allowlist is NOT being enforced. Do not resume the dedicated TEST pilot connection until the server is restarted in enforce mode and the recipient is approved.",
    "ar": "قائمة سماح المستلمين الخاصة بالتجربة غير مفروضة. لا تستأنف اتصال TEST المخصص قبل تشغيل الخادم بوضع enforce واعتماد المستلم التجريبي."
  },
  "devPilotHubTitle": {
    "en": "TEST Pilot control center",
    "ar": "لوحة إدارة Pilot التجريبي"
  },
  "devPilotHubHint": {
    "en": "Choose an OpenWA connection to prepare, set limits, approve a recipient, start or stop sending. Each connection is independent; no PowerShell commands are needed.",
    "ar": "اختر اتصال OpenWA من القائمة للتحكم في التجهيز وحدود الإرسال والمستلم المعتمد والتفعيل والإيقاف. كل اتصال مستقل، ولا يلزم تشغيل أوامر PowerShell."
  },
  "devPilotChooseConnection": {
    "en": "Select the TEST session",
    "ar": "الجلسة التي تريد اختبارها"
  },
  "devPilotManageThisConnection": {
    "en": "Manage Pilot",
    "ar": "إدارة Pilot"
  },
  "devPilotAutoEnforceHint": {
    "en": "The TEST server enforces the pilot recipient allowlist automatically. Start or stop each connection here; no OPENWA_PILOT_MODE edit is needed. Other unapproved OpenWA sends on TEST may be blocked.",
    "ar": "حماية قائمة السماح مفعّلة تلقائيًا على خادم TEST. تستطيع التحكم في بدء وإيقاف كل جلسة من هذه اللوحة؛ لا حاجة لتغيير OPENWA_PILOT_MODE في ملفات البيئة. قد تُمنع عمليات OpenWA الأخرى غير المعتمدة في TEST."
  },
  "devPilotNeedsSetup": {
    "en": "Pilot is not configured on this connection",
    "ar": "لم تُجهز إعدادات Pilot لهذا الاتصال"
  },
  "devPilotSetupHint": {
    "en": "Prepare only this existing TEST session with safe caps, paused sending, and no recipient approval. It does not create a new OpenWA session or send a message.",
    "ar": "جهّز جلسة TEST الموجودة بحدود آمنة وإيقاف إرسال دون اعتماد أي مستلم. لا يُنشئ جلسة جديدة ولا يرسل رسالة."
  },
  "devPilotPrepare": {
    "en": "Prepare pilot on this connection",
    "ar": "تجهيز Pilot لهذا الاتصال"
  },
  "devPilotPrepared": {
    "en": "Pilot controls prepared and sending paused on this connection.",
    "ar": "تم تجهيز حدود Pilot وإيقاف الإرسال لهذا الاتصال."
  },
  "devPilotGatewayUpdate": {
    "en": "Update this connection's gateway URL",
    "ar": "تحديث رابط البوابة لهذا الاتصال"
  },
  "devPilotGatewayUpdateHint": {
    "en": "Enter the current gateway URL and API key above, then update this existing connection; it will verify the same upstream session without creating another.",
    "ar": "أدخل رابط البوابة الجديد ومفتاح API أعلاه، ثم حدّث الاتصال الحالي. سيتحقق من الجلسة الموجودة دون إنشاء جلسة أخرى."
  },
  "devPilotGatewayUpdated": {
    "en": "Gateway URL updated on the existing connection.",
    "ar": "تم تحديث رابط البوابة على الاتصال الموجود."
  },
  "devPilotTitle": {
    "en": "DEV pilot — TEST connection controls",
    "ar": "Pilot تجريبي — إدارة اتصال TEST"
  },
  "devPilotLoading": {
    "en": "Loading pilot configuration…",
    "ar": "جارٍ تحميل إعدادات التجربة…"
  },
  "devPilotRuntimeNote": {
    "en": "TEST only. The Next.js server must run in enforce mode; the browser cannot change server environment variables.",
    "ar": "يعمل هذا التحكم على TEST فقط. وضع enforce على خادم Next.js مطلوب، ولا يمكن تغييره من واجهة المتصفح."
  },
  "devPilotState": {
    "en": "Pilot",
    "ar": "حالة التجربة"
  },
  "devPilotActive": {
    "en": "Active",
    "ar": "مفعّلة"
  },
  "devPilotInactive": {
    "en": "Inactive",
    "ar": "غير مفعّلة"
  },
  "devPilotPaused": {
    "en": "Paused",
    "ar": "إيقاف الإرسال"
  },
  "devPilotYes": {
    "en": "Yes",
    "ar": "نعم"
  },
  "devPilotNo": {
    "en": "No",
    "ar": "لا"
  },
  "devPilotGrants": {
    "en": "Active grants",
    "ar": "موافقات سارية"
  },
  "devPilotPending": {
    "en": "Unsettled sends",
    "ar": "رسائل معلّقة"
  },
  "devPilotDuplicateWarning": {
    "en": "Warning: multiple ready connections share the same identity. Check the exact OpenWA session before activation.",
    "ar": "تنبيه: توجد عدة اتصالات جاهزة للهوية نفسها. تحقق من جلسة OpenWA الصحيحة قبل التفعيل."
  },
  "devPilotHourly": {
    "en": "Hourly send cap",
    "ar": "حد الرسائل/ساعة"
  },
  "devPilotDaily": {
    "en": "Daily send cap",
    "ar": "حد الرسائل/24 ساعة"
  },
  "devPilotFirstTouch": {
    "en": "New recipients per 24h",
    "ar": "حد المستلمين الجدد/24 ساعة"
  },
  "devPilotInterval": {
    "en": "Minimum interval (ms)",
    "ar": "الحد الأدنى بين الإرسالات (مللي ثانية)"
  },
  "devPilotJitter": {
    "en": "Jitter (ms)",
    "ar": "التأخير العشوائي (مللي ثانية)"
  },
  "devPilotSaveLimits": {
    "en": "Save pilot limits",
    "ar": "حفظ حدود التجربة"
  },
  "devPilotRecipient": {
    "en": "Consenting test recipient",
    "ar": "المستلم التجريبي"
  },
  "devPilotRecipientHint": {
    "en": "Used only to derive a scoped SHA-256 hash; the plaintext is not persisted. Grant is manual-only and expires in 4 hours.",
    "ar": "يُستخدم الرقم أو معرّف @lid لإنشاء بصمة مشفرة النطاق؛ لا يُحفظ الرقم بصيغته الأصلية. الموافقة مدتها 4 ساعات ولمحادثة يدوية واحدة فقط."
  },
  "devPilotConsent": {
    "en": "I confirm this recipient consented to the test message",
    "ar": "أؤكد موافقة المستلم على الرسالة التجريبية"
  },
  "devPilotDuplicateAck": {
    "en": "I reviewed duplicate identities and verified the intended session",
    "ar": "راجعت اتصالات الهوية المتكررة وتحققت من الجلسة الصحيحة"
  },
  "devPilotGrant": {
    "en": "Approve recipient (4 hours)",
    "ar": "اعتماد مستلم (4 ساعات)"
  },
  "devPilotActivate": {
    "en": "Start pilot on this connection",
    "ar": "بدء التجربة لهذا الاتصال"
  },
  "devPilotStop": {
    "en": "Stop pilot and revoke grants",
    "ar": "إيقاف التجربة وسحب الموافقة"
  },
  "devPilotStopHint": {
    "en": "Stop blocks new sends and revokes approvals, but already in-flight provider requests may complete. Never blindly resend ambiguous messages.",
    "ar": "زر الإيقاف يمنع الإرسال الجديد ويسحب الموافقات، لكن إرسالًا سبق وصوله للمزود قد يكتمل. لا تعِد إرسال رسالة مجهولة النتيجة."
  },
  "devPilotStopped": {
    "en": "Pilot stopped; grants revoked.",
    "ar": "توقف Pilot وسُحبت الموافقات."
  },
  "devPilotStarted": {
    "en": "Pilot activated on the selected connection.",
    "ar": "تم بدء Pilot على الاتصال المحدد."
  },
  "devPilotGranted": {
    "en": "Test recipient approved; sending remains paused.",
    "ar": "تم اعتماد مستلم اختباري دون بدء الإرسال."
  },
  "devPilotLimitsSaved": {
    "en": "Pilot limits saved.",
    "ar": "حُفظت حدود الإرسال التجريبي."
  },
  "pauseSending": {
    "en": "Pause sending",
    "ar": "إيقاف الإرسال"
  },
  "resumeSending": {
    "en": "Resume sending",
    "ar": "استئناف الإرسال"
  },
  "sendingPaused": {
    "en": "OpenWA sending is paused",
    "ar": "تم إيقاف الإرسال عبر OpenWA"
  },
  "sendingResumed": {
    "en": "OpenWA sending resumed",
    "ar": "تم استئناف الإرسال عبر OpenWA"
  },
  "pauseSendingHint": {
    "en": "New sends are blocked. In-flight provider requests may still complete; investigate ambiguous sends before resuming. Resuming does not bypass pilot allowlist.",
    "ar": "تُمنع عمليات الإرسال الجديدة. قد تكتمل طلبات أُرسلت للمزود بالفعل؛ تحقق من الرسائل مجهولة النتيجة قبل الاستئناف. الاستئناف لا يتجاوز قائمة السماح للتجربة."
  },
  "actionFailed": {
    "en": "Session action failed",
    "ar": "تعذّر تنفيذ إجراء الجلسة"
  },
  "creating": {
    "en": "Creating",
    "ar": "جارٍ الإنشاء"
  },
  "waiting_qr": {
    "en": "Waiting for QR",
    "ar": "بانتظار مسح رمز QR"
  },
  "authenticating": {
    "en": "Authenticating",
    "ar": "جارٍ المصادقة"
  },
  "ready": {
    "en": "Ready",
    "ar": "جاهز"
  },
  "failed": {
    "en": "Failed",
    "ar": "فشل"
  },
  "reconnecting": {
    "en": "Reconnecting",
    "ar": "جارٍ إعادة الاتصال"
  },
  "restricted": {
    "en": "Restricted",
    "ar": "مقيّد"
  },
  "logged_out": {
    "en": "Logged out",
    "ar": "تم تسجيل الخروج"
  }
} as const
export type WhatsAppLabel = keyof typeof labels
export function useWhatsAppLabels() {
  const locale = useLocale()
  return (key: WhatsAppLabel) => labels[key][locale === 'ar' ? 'ar' : 'en']
}
