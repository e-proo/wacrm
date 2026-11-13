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
  "devPilotPerSessionTitle": {
    "en": "TEST Pilot — per-session protection",
    "ar": "حماية Pilot في TEST — لكل جلسة بشكل مستقل"
  },
  "devPilotModeTitle": {
    "en": "Pilot mode for this OpenWA session",
    "ar": "وضع Pilot لجلسة OpenWA هذه"
  },
  "devPilotModeEnabledHint": {
    "en": "Pilot requires a recipient approval. Emergency Stop is separate from disabling Pilot.",
    "ar": "يتطلب Pilot موافقة على المستلم. الإيقاف الطارئ مستقل عن تعطيل Pilot."
  },
  "devPilotModeDisabledHint": {
    "en": "Pilot allowlist is off for this TEST session only; ordinary anti-abuse limits remain enforced.",
    "ar": "قائمة سماح Pilot معطلة لهذه الجلسة في TEST فقط؛ وتظل حدود الحماية العامة سارية."
  },
  "devPilotDisableButton": {
    "en": "Disable Pilot and allow normal sending",
    "ar": "تعطيل Pilot والسماح بالإرسال العادي"
  },
  "devPilotEnableButton": {
    "en": "Enable Pilot (pause sending)",
    "ar": "تفعيل Pilot (إيقاف الإرسال حتى الاعتماد)"
  },
  "devPilotDisableConfirm": {
    "en": "Disable Pilot for this ready session and allow ordinary sending? Confirm this is the correct WhatsApp account. Anti-abuse limits still apply.",
    "ar": "هل تريد تعطيل Pilot لهذه الجلسة الجاهزة والسماح بالإرسال العادي؟ تأكد من أنها جلسة واتساب الصحيحة. ستبقى حدود الحماية العامة سارية."
  },
  "devPilotNormalMode": {
    "en": "Normal sending",
    "ar": "إرسال عادي"
  },
  "devPilotNormalModeHint": {
    "en": "Pilot is disabled here. Emergency Stop still pauses sends; gateway, conversation identity, and webhook errors remain independent.",
    "ar": "Pilot معطل هنا. يظل الإيقاف الطارئ يوقف الإرسال، ولا يعالج هذا الخيار أخطاء البوابة أو هوية المحادثة أو الويب هوك."
  },
  "devPilotResumeNormal": {
    "en": "Resume normal sending",
    "ar": "استئناف الإرسال العادي"
  },
  "devPilotDisabled": {
    "en": "Pilot disabled for this TEST session. Normal sending resumed with general safety guardrails.",
    "ar": "تم تعطيل Pilot لهذه الجلسة في TEST واستئناف الإرسال العادي مع استمرار الحماية العامة."
  },
  "devPilotEnabled": {
    "en": "Pilot enabled, sends paused and old approvals revoked. Approve a recipient and activate Pilot again.",
    "ar": "تم تفعيل Pilot وإيقاف الإرسال وإلغاء الموافقات القديمة. اعتمد المستلم وابدأ Pilot مجددًا."
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
    "en": "TEST defaults to enforced Pilot for each session. Disable Pilot explicitly on a selected session to resume normal sending; Stop is only an emergency pause.",
    "ar": "يعمل Pilot تلقائيًا لكل جلسة في TEST. استخدم زر تعطيل Pilot للجلسة المختارة للعودة إلى الإرسال العادي؛ أما زر الإيقاف فهو إيقاف طارئ للإرسال فقط."
  },
  "devPilotEasyTitle": {
    "en": "OpenWA test sending",
    "ar": "تجربة إرسال OpenWA"
  },
  "devPilotEasyHint": {
    "en": "Follow the steps to test one session safely. Existing limits are preserved and can be adjusted under Advanced settings.",
    "ar": "اتبع الخطوات بالتسلسل لاختبار جلسة واحدة بأمان. تُحفظ الحدود السابقة ويمكن تغييرها من الإعدادات المتقدمة."
  },
  "devPilotProtected": {
    "en": "Allowlist protected",
    "ar": "الحماية مفعلة"
  },
  "devPilotVerifiedGateway": {
    "en": "Gateway verified",
    "ar": "تحقق الاتصال"
  },
  "devPilotStepVerify": {
    "en": "Verify",
    "ar": "تحقق"
  },
  "devPilotStepPrepare": {
    "en": "Prepare",
    "ar": "جهّز"
  },
  "devPilotStepApprove": {
    "en": "Approve",
    "ar": "اعتمد"
  },
  "devPilotStepStart": {
    "en": "Start",
    "ar": "ابدأ"
  },
  "devPilotDuplicateCount": {
    "en": "Connections sharing this number",
    "ar": "اتصالات للرقم نفسه"
  },
  "devPilotDuplicateExplain": {
    "en": "This is not a failure. Multiple sessions are registered for this phone. Compare the OpenWA session ID before approving a recipient.",
    "ar": "هذه ليست رسالة فشل. توجد أكثر من جلسة مسجلة لنفس الرقم. تحقق من معرّف الجلسة المستخدمة في OpenWA قبل اعتماد المستلم."
  },
  "devPilotInspectSessions": {
    "en": "Show sessions and compare IDs",
    "ar": "عرض الجلسات ومقارنة المعرّفات"
  },
  "devPilotChosenSession": {
    "en": "Selected session",
    "ar": "الجلسة المختارة"
  },
  "devPilotOtherSession": {
    "en": "Other session",
    "ar": "جلسة أخرى"
  },
  "devPilotDuplicateCompare": {
    "en": "Match the selected OpenWA session ID with the OpenWA dashboard. Do not delete or recreate sessions merely because the Cloudflare URL changed.",
    "ar": "طابق معرّف جلسة OpenWA المختارة مع لوحة OpenWA. لا تحذف الجلسات أو تعاود إنشاء جلسة بسبب تغيير رابط Cloudflare."
  },
  "devPilotVerifyTitle": {
    "en": "Step 1: Verify the session",
    "ar": "الخطوة الأولى: تحقق من الجلسة"
  },
  "devPilotVerifyDescription": {
    "en": "Check the actual OpenWA gateway session rather than only the stored WACRM status. If the Cloudflare URL changed, update the existing connection above and retry.",
    "ar": "اضغط للتحقق من جلسة OpenWA الحقيقية، وليس من حالة WACRM المخزنة فقط. إذا تغيّر رابط Cloudflare، حدّث الرابط أعلاه على نفس الاتصال ثم أعد التحقق."
  },
  "devPilotVerifyButton": {
    "en": "Verify OpenWA session",
    "ar": "التحقق من جلسة OpenWA"
  },
  "devPilotVerifySuccess": {
    "en": "The OpenWA gateway confirms this session is ready. Continue to the next step.",
    "ar": "تم التحقق من اتصال الجلسة عبر OpenWA. يمكنك متابعة الخطوة التالية."
  },
  "devPilotVerifyFailed": {
    "en": "Unable to verify the OpenWA session. Check the gateway URL and API key or update the URL, then retry.",
    "ar": "تعذّر الوصول إلى جلسة OpenWA. اختبر رابط البوابة ومفتاح API أو حدّث الرابط ثم أعد المحاولة."
  },
  "devPilotVerifyNotReady": {
    "en": "OpenWA responded but the session is not ready to send. Check its WhatsApp login and session state, then retry.",
    "ar": "استجاب OpenWA لكن الجلسة ليست جاهزة للإرسال. تحقق من تسجيل دخول واتساب وحالة الجلسة ثم أعد المحاولة."
  },
  "devPilotApproveTitle": {
    "en": "Next: Approve one test recipient",
    "ar": "الخطوة التالية: اعتمد رقمًا واحدًا للاختبار"
  },
  "devPilotApproveDescription": {
    "en": "Enter an international number belonging to a consenting test recipient. Approval does not send anything; the connection remains paused until Start.",
    "ar": "أدخل رقم المستلم الذي وافق على التجربة بصيغة دولية. لا يبدأ الإرسال عند الاعتماد؛ يبقى الاتصال موقوفًا حتى تضغط «بدء التجربة»."
  },
  "devPilotRecipientFormat": {
    "en": "Example: +9677XXXXXXXX or 9677XXXXXXXX. Spaces or an exact @lid chat ID are accepted; the plaintext recipient is not stored in the allowlist.",
    "ar": "مثال: +9677XXXXXXXX أو 9677XXXXXXXX. يمكن إدخال المسافات أو معرّف واتساب @lid الصحيح؛ لا يُحفظ الرقم نفسه في قائمة السماح."
  },
  "devPilotInvalidRecipient": {
    "en": "Enter a valid international number (7–15 digits including country code) or an exact @lid identity.",
    "ar": "تحقق من الرقم الدولي: من 7 إلى 15 رقمًا يبدأ برمز الدولة، أو معرّف @lid صالح."
  },
  "devPilotMustReviewDuplicates": {
    "en": "Before continuing, review the duplicate sessions above, compare their IDs and confirm that review.",
    "ar": "قبل المتابعة، اعرض الجلسات المتكررة أعلاه، وطابق المعرّفات، ثم أكد مراجعتها."
  },
  "devPilotReadyToStart": {
    "en": "Recipient approved — ready to start",
    "ar": "المستلم معتمد — أنت جاهز لبدء التجربة"
  },
  "devPilotStartDescription": {
    "en": "There is exactly one active grant. Start only unpauses this session; it does not automatically send a message.",
    "ar": "هناك موافقة نشطة واحدة. الضغط على «بدء التجربة» يرفع الإيقاف عن هذه الجلسة فقط ولا يرسل رسالة تلقائيًا."
  },
  "devPilotNowActive": {
    "en": "Pilot active for this session",
    "ar": "Pilot مفعّل لهذه الجلسة"
  },
  "devPilotSendOneMessage": {
    "en": "Open WACRM Inbox and send exactly one text to the approved recipient, then return here and Stop. Never blindly retry an uncertain send.",
    "ar": "انتقل إلى صندوق الوارد في WACRM وأرسل رسالة نصية واحدة فقط للمستلم المعتمد، ثم عد هنا واضغط إيقاف التجربة. لا تعاود إرسال رسالة بنتيجة غير مؤكدة."
  },
  "devPilotEnforceRequired": {
    "en": "The server admission gate is not enforced. Do not start sending until the TEST environment is corrected.",
    "ar": "حماية قائمة السماح غير مفعلة على هذا الخادم. لا تبدأ الإرسال قبل إصلاح إعداد TEST."
  },
  "devPilotUnsettledBlocked": {
    "en": "An unsettled send may already have reached OpenWA. Reconcile it before any new send; do not blindly retry.",
    "ar": "توجد رسالة معلّقة قد يكون OpenWA أرسلها بالفعل. راجع حالتها قبل أي إرسال جديد، ولا تضغط إعادة الإرسال."
  },
  "devPilotNoGrantUnpaused": {
    "en": "Sending is unpaused without an active test grant. Stop first, then verify and approve a recipient.",
    "ar": "حالة الإرسال مفتوحة دون موافقة اختبار فعالة. اضغط «إيقاف التجربة» أولًا ثم أعد التحقق والاعتماد."
  },
  "devPilotTooManyGrants": {
    "en": "Multiple grants are active. Stop and revoke them, then approve just one recipient.",
    "ar": "توجد عدة موافقات فعالة. أوقف التجربة واسحب الموافقات، ثم اعتمد مستلمًا واحدًا فقط."
  },
  "devPilotReverify": {
    "en": "Recheck session",
    "ar": "إعادة التحقق من الجلسة"
  },
  "devPilotAdvanced": {
    "en": "Advanced sending limits",
    "ar": "إعدادات الإرسال المتقدمة"
  },
  "devPilotLimitsHelp": {
    "en": "You do not need to change these for a first test. Defaults: 3/hour, 10/day, 1 new recipient and 15-second spacing. Changes are allowed only while paused.",
    "ar": "لا تحتاج إلى تعديلها للتجربة الأولى. الحد الافتراضي 3 رسائل/ساعة، 10 رسائل/يوم، مستلم جديد واحد، وفاصل 15 ثانية. التعديل متاح فقط أثناء إيقاف الإرسال."
  },
  "devPilotActionRejected": {
    "en": "Action could not be completed. Refresh the session and check the requirements above.",
    "ar": "تعذّر تنفيذ الإجراء. حدّث حالة الجلسة وراجع المتطلبات الموضحة أعلاه."
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
  "editSessionSettings": {
    "en": "Edit session settings",
    "ar": "تعديل إعدادات الجلسة"
  },
  "sessionSettingsSave": {
    "en": "Save session settings",
    "ar": "حفظ إعدادات الجلسة"
  },
  "sessionSettingsSaved": {
    "en": "Session settings saved successfully.",
    "ar": "تم حفظ إعدادات الجلسة بنجاح."
  },
  "sessionNameRequired": {
    "en": "Enter a session name (up to 120 characters).",
    "ar": "أدخل اسمًا للجلسة لا يتجاوز 120 حرفًا."
  },
  "sessionApiKeyPlaceholder": {
    "en": "Enter a new API key to rotate the gateway",
    "ar": "أدخل مفتاح API الجديد عند تحديث البوابة"
  },
  "sessionApiKeyHint": {
    "en": "The saved API key is never displayed. Leave this blank to keep it unchanged when editing only the session name.",
    "ar": "لا يُعرض مفتاح API المحفوظ. اترك الحقل فارغًا إذا كنت تعدّل اسم الجلسة فقط."
  },
  "sessionGatewayKeyRequired": {
    "en": "To update the gateway URL, enter its API key as well.",
    "ar": "لتحديث رابط البوابة، أدخل مفتاح API الخاص بها أيضًا."
  },
  "sessionGatewayMissingId": {
    "en": "This connection has no confirmed OpenWA session ID. Reconcile it before changing the gateway.",
    "ar": "لا يوجد معرّف مؤكد لهذه الجلسة على OpenWA. تحقق من تطابق الجلسة قبل تحديث البوابة."
  },
  "sessionGatewayTestOnly": {
    "en": "Gateway URL and API key rotation is currently restricted to TEST. You can still rename this session.",
    "ar": "تحديث رابط البوابة ومفتاح API متاح حاليًا في TEST فقط. يمكنك تعديل اسم الجلسة هنا."
  },
  "sessionSettingsIdentityHint": {
    "en": "Changing a gateway verifies this exact upstream session; it will not create or resend a session. Pilot controls are separate.",
    "ar": "عند تغيير البوابة سيتم التحقق من هوية الجلسة نفسها دون إنشاء جلسة أو إعادة إرسال. إعدادات Pilot منفصلة."
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
    "en": "On this TEST project, recipient allowlist enforcement is automatic. Use the session-specific Start/Stop controls below. Approval is required before the first send; unapproved OpenWA sends from other TEST sessions are blocked.",
    "ar": "حماية قائمة سماح المستلمين مفعّلة تلقائيًا على مشروع TEST. استخدم أزرار بدء وإيقاف الجلسة أدناه. لا يُسمح بإرسال رسالة قبل اعتماد المستلم، وتُمنع الرسائل غير المعتمدة من جلسات TEST الأخرى."
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
  "devPilotGrantedNativeChat": {
    "en": "Recipient approved for the verified native OpenWA chat on this session (including @lid if used). No message was sent; start the Pilot only after pending messages are reconciled.",
    "ar": "تم اعتماد المستلم بهوية محادثة OpenWA الأصلية على هذه الجلسة (بما فيها @lid عند استخدامها). لم تُرسل أي رسالة؛ لا تبدأ التجربة قبل تسوية الرسائل المعلّقة."
  },
  "conversationPilotApprovalRequired": {
    "en": "This OpenWA chat is not authorized in TEST Pilot. In Settings → WhatsApp → TEST Pilot, stop/revoke any old grant, approve the consenting recipient again for this exact session and native chat, then start. Do not send to other numbers.",
    "ar": "هذه المحادثة غير معتمدة في Pilot. من الإعدادات ← واتساب ← TEST Pilot أوقف الموافقة القديمة واسحبها، ثم اعتمد المستلم الموافق مجددًا على هذه الجلسة وهويتها الأصلية وابدأ التجربة. لا ترسل لأرقام أخرى."
  },
  "conversationConnectionMustSelect": {
    "en": "The conversation's original OpenWA session is unavailable. Select a current, same-account/same-phone connection from the session menu before sending. No automatic session switch.",
    "ar": "جلسة OpenWA الأصلية لهذه المحادثة غير متاحة. اختر جلسة حالية للرقم نفسه من قائمة الاتصالات أعلى المحادثة قبل الإرسال. لن تُغيَّر الجلسة تلقائيًا."
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
