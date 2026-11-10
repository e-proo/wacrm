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
