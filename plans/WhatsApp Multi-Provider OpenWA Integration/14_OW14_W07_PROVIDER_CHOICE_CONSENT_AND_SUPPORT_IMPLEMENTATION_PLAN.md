# OW14-W07 — Provider Choice, Account Opt-in, Safe Activation & Customer Support
## خطة تنفيذ إنتاجية — WACRM / WhatsApp Multi-Provider

**الحالة:** P0 Architecture/UX/DoD planned — لا يوجد ادعاء بتنفيذ W07 أو اجتياز TEST.
**المرجع:** e-proo/wacrm / refactor/service-platform-v2.
**تاريخ المراجعة:** 2026-11-20.
**Linear:** [SOF-54](https://linear.app/eproo/issue/SOF-54).
**البيئة:** Windows للتطوير والاختبارات غير الحية حاليًا؛ إيقاف أي تغيير/اختبار على VPS إلى حين إذن منفصل.
**التبعيات:** OW14-W06 مؤجلة بقرار المالك (SOF-53؛ قياس VPS الأول فقط موثق). OW14-W05 / OW-12 / OW-13 / W04 / W03 وأدلة Production GO مستقلة ولم تُغلق.

> هذه خطة تنفيذ، **وليست** موافقة على استخدام OpenWA في Production أو تجاوز سياسات WhatsApp. Meta Cloud API هو المزود الرسمي والافتراضي؛ OpenWA نقل اختياري ذاتي الاستضافة، قائم على WhatsApp Web/linked device وليس Meta Cloud API رسميًا.

## 1. الهدف الإنتاجي ومعايير التصميم

توفير تجربة آمنة وواضحة تجعل مسؤول الحساب يفهم الفروق بين **Meta Cloud API** و**OpenWA**، ويقرّ صراحةً بمخاطر استخدام OpenWA، ويستطيع إدارة تفعيله/تعطيله على مستوى الحساب والجلسة، مع سجل تدقيق ومساعدة فنية عربية/إنجليزية. يجب أن يكون **التفعيل التشغيلي للإرسال من OpenWA افتراضيًا مغلقًا على Production**، مستقلاً عن زر Pilot الموجود على Supabase TEST. لا نفترض أن مجرد إضافة جلسة أو نجاح QR أو إيقاف Pilot أو موافقة المستلم يجعل المزود مفعلًا للإرسال الإنتاجي.

**ثوابت لا تفاوض فيها:**
- Meta official/default؛ لا تحويل صامت إلى OpenWA أو العكس؛ لا auto-failover ولا تعديل تلقائي لاتصال محادثة أو مهمة أو بث.
- WACRM يملك السياسات والأعمال والـagents/automations/broadcasts/audit/idempotency؛ OpenWA يبقى Transport مستقلًا خارج Next.js.
- جميع العمليات محكومة بـ account_id + connection_id وتفويض server-side؛ service_role لا يرفع قيد ملكية الحساب.
- لا كشف QR أو مفاتيح API أو HMAC أو JID/هاتف أو message body في سجلات الموافقة أو الدعم أو telemetry.
- لا فتح مسار إرسال ثانٍ؛ نفّذ الحظر في حدود النقل المشتركة ثم أعد التحقق قبل استدعاء provider الفعلي.
- لا blind resend ولا تحويل نتيجة الإرسال غير المؤكدة إلى delivered/failed؛ أي تغيير سياسات لا يعالج رسالة أُرسلت بالفعل.
- تعديلات schema عبر migrations **إضافية جديدة** فقط؛ لا تعديل migrations مطبقة ولا توسيع RLS/grants كحل سريع.
- موافقة صاحب الحساب على **مخاطر المزود** مختلفة تمامًا عن **موافقة مستلم الرسالة**. لا تغني أيٌّ منهما عن الأخرى ولا عن سياسات المنصة والقوانين ذات الصلة.
- Build/CI والاختبارات المحلية ليست live acceptance ولا Production authorization.

## 2. أدلة المستودع الحالية والفجوة التي ستُعالَج

تدقيق source تم على HEAD **e2fc23f58927d33e4a31cc442aaae0741439f1ef** بتاريخ 2026-11-20؛ يعاد التحقق منه عند بداية كل حزمة وبعد كل commit.

| الموجود بالفعل (لا نكرّره) | الملف / الدليل | فجوة W07 |
| --- | --- | --- |
| نموذج Meta/OpenWA واتصالات tenant-scoped | supabase/migrations/143_whatsapp_provider_neutral_connections.sql | لا يوجد ضمن النموذج فحص موافقة تشغيلية إنتاجية مثبت للحساب/الاتصال |
| اختيار اتصال واعتماد account scope في router | src/lib/whatsapp/transport/router.ts | نحتاج admission policy مستقلة قبل OpenWA provider dispatch في كل workloads |
| OpenWA Guarded transport / وقف يدوي / pilot caps | src/lib/whatsapp/transport/guardrails.ts | Pilot على TEST ليس consent/production enablement |
| إدارة الجلسات وQR وأزرار الوقف | src/app/api/whatsapp/connections/openwa/* وsrc/lib/whatsapp/transport/openwa/session-auth.ts | فصل onboarding/status/TEST Pilot عن موافقة مخاطر التشغيل وتمكين الإنتاج |
| واجهة Meta + OpenWA بالعربية/الإنجليزية جزئيًا | src/components/settings/whatsapp-config.tsx وopenwa-connections.tsx وwhatsapp-labels.ts | اختيار واضح وإيضاحات المخاطر، حالة تفعيل فعلية، تأكيد، سجل، تجربة تيسيرية |
| قوائم الإرسال للمحادثات والبث | src/app/api/whatsapp/conversations/send-connections/route.ts وbroadcast/connections/route.ts | إظهار حالة السماح بدقة ومنع الخيارات غير المفَعّلة دون كشف سر أو تغيير مسار الإرسال |
| صلاحيات إعدادات Admin+ | src/lib/auth/roles.ts وopenwa/session-auth.ts | ربط قبول المخاطر بصاحب الحساب، وعمليات التشغيل بمسؤول مخوّل، دون تجاوز auth على API |
| TEST Pilot admission وmode/paused toggles | migrations 155/156/194؛ endpoint pilot | لا يُعاد استخدام pilot_enabled كراية موافقة إنتاجية |
| تنبيهات الرسائل غير المؤكدة ومراجعة ACK | W05 transport/reconciliation | عند تعطيل OpenWA تبقى المراجعة والـreceipt intake متاحة؛ لا إسقاط أدلة أو إعادة إرسال |
| قائمة المخاطر الأمنية NOTE-001 | PROJECT_NOTES.md | موافقة W07 لا تعني إغلاق فحص Supabase Auth أو موافقة Security/Legal |

**قرارات التصميم التي ستثبت قبل الكود:** Owner يقر بمخاطر المزود وسياسة البيانات لأول مرة؛ Admin+ يملك التحكم في تفعيل جلسة بعد استيفاء موافقة الحساب، ويمكن للـOwner سحبها. إذا تغير نموذج تفويض المسؤولين فليكن قرار Product/Security موثقًا قبل migration؛ لا يُسمح لوكيل AI بقبول المخاطر أو إدارة الجلسة/المفاتيح.

## 3. نطاق W07 وحدوده

**داخل W07:**
1. شرح ومقارنة المزودين باللغة العربية/الإنجليزية، مع عدم المبالغة في قدرات أي منهما.
2. موافقة مالك الحساب على المخاطر وشروط الاستخدام ذات إصدار محدد + revocation/re-acceptance.
3. حالة تشغيل OpenWA مقيدة بالحساب والاتصال، مربوطة بعلم إصدار/بيئة يمنع التمكين الإنتاجي افتراضيًا.
4. منع جميع أنواع **outbound OpenWA** عند انعدام الإذن، مع أسباب مناسبة للعمليات والواجهة.
5. Audit وRBAC وRLS وtenant isolation وواجهات إعدادات نظيفة وتقارير حالة آمنة.
6. إرشادات الدعم والحوادث، وتصنيف الأعطال وstop/suspension/manual recovery، مع توثيق حدود الدعم والمسؤوليات.
7. اختبارات تقنية محلية/CI وتجهيز حزمة أدلة TEST حية مؤجلة.

**خارج W07، لا نكررها:** تطوير Gateway/OpenWA engine، نسخ جلسات وDR الخاص بـW06، آلية reliable ACK/media لدى W05، سياسات consent الفردية الكاملة أو إعادة تصميم broadcast، واجهة إنتاج فعلية دون GO، دعم auto-failover، تحسين Cloudflare/CloudPanel، تشغيل فحص حي دون موافقة، إزالة قيود مكافحة الإساءة، بناء منصة تنبيه عامة (NOTE-019).

## 4. تجربة الاستخدام (UX) المقترحة

### 4.1 شاشة واحدة مفهومة لا لوحة مشتتة

**Settings → WhatsApp → مزود الاتصال**
- بطاقة **Meta Cloud API** مع تعريف واضح: «رسمي / الافتراضي للإنتاج» + حالة الاتصال + رابط إعداداته. لا نقله أو استبداله عند تفعيل OpenWA.
- بطاقة **WhatsApp Web (OpenWA)**: «اختياري / ذاتي الاستضافة / غير رسمي» + الحالة الإجمالية ومؤشر **الاعتماد التشغيلي** المنفصل عن **حالة الجلسة** و**Pilot TEST**.
- الملخص يبين **الاتصالات الجاهزة، المفعّلة للإرسال، الموقوفة، وتحتاج قبولًا جديدًا**، ثم تفاصيل الجلسة تُفتح عند الطلب. لا يكرر التحذير الطويل داخل كل جلسة.
- **حالة كل اتصال**: Gateway Ready / Consent Missing / Policy Version Stale / Account Revoked / Production Gate Off / Admin Paused / Guardrail Restricted / Enabled. هذه حالة فعالة محسوبة من الخادم، لا مجرد switch client-side.
- لكل جلسة: «تفاصيل وشروط التفعيل» و«سجل الموافقات» و«إيقاف إرسال OpenWA» و«حالة الاتصال» و«مساعدة واستعادة»؛ فصل إعدادات QR/الرابط/المفتاح وPilot عن الموافقة.
- الخيارات في inbox/tasks/broadcasts تعرض المزود، حالة الجلسة وسبب عدم التوفر، وتبقى القواعد بيد الخادم حتى لو حُدّث العميل متأخرًا. لا كشف session credentials.
- حالات Loading/Empty/Error/Insufficient permission وRTL/LTR واختبارات keyboard/focus والسرد لقارئ الشاشة؛ no-store للبيانات الحساسة؛ تأكيد واضح مع اسم الحساب/الاتصال قبل العمليات.

### 4.2 مسار قبول/تفعيل مستقل عن الربط

~~~text
Meta remains default
       |
OpenWA connection created/configured (NOT outbound-enabled)
       |
Admin reviews risks + owner accepts versioned policy
       |
Product/Legal-approved policy version recorded (account)
       |
Authorized admin selects specific connection + reviews effective status
       |
Server verifies connection/role/account/policy/environment/STOP/guardrails
       |
Explicit activation only when release gate authorizes it
       |
WACRM unified outbound guarded dispatch (never automatic send on activation)
~~~

التفعيل لا يؤدي إلى إرسال الرسائل المنتظرة تلقائيًا. يجب على المشغّل مراجعة backlog/caps/recipient approvals وعمليات الإرسال غير المؤكدة قبل تمكين أي worker أو إعادة الإرسال. أي إرسال بدأ قبل السحب لا يمكن التراجع عنه.

### 4.3 نصوص أولية للمراجعة Product/Legal (ليست نسخة قانونية معتمدة)

**AR — تنبيه:**
«OpenWA اتصال اختياري يعتمد على جلسة جهاز مرتبط عبر WhatsApp Web، وليس واجهة Meta Cloud API الرسمية. قد ينقطع الاتصال أو تحتاج الجلسة إلى إعادة ربط، وقد تتأثر القدرة على إرسال الرسائل أو حالة الرقم وفق سياسات WhatsApp. لا نضمن استمرارية الجلسة أو توصيل الرسائل. تبقى مسؤولًا عن موافقات المستلمين ومحتوى الرسائل والالتزام بالسياسات المعمول بها. يمكنك إيقاف OpenWA مع بقاء Meta إعداد الاتصال الرسمي الافتراضي.»

**EN — warning:**
“OpenWA is an optional self-hosted WhatsApp Web linked-device integration, not the official Meta Cloud API. Sessions may disconnect, require relinking, or be restricted under WhatsApp policies. Continuous availability and message delivery are not guaranteed. You remain responsible for recipient permissions, message content, and applicable policies. Meta remains the official default provider.”

**AR — نص الموافقة المنفصلة:**
«أقرّ بأنني مسؤول مخوّل لهذا الحساب، وقد قرأت مخاطر استخدام OpenWA وشروط تشغيله المحددة بالإصدار المعروض. أفهم أن قبول هذه الشروط لا يبدأ إرسال الرسائل ولا يتجاوز الموافقات والقيود الأخرى.»

**EN — acknowledgment:**
“I am an authorized account owner, have reviewed the OpenWA risks and the displayed policy version, and understand that accepting does not start sending or override recipient consent and safety controls.”

**مراجعة قانونية إلزامية** قبل استخدام النصوص للعملاء: المصطلحات والتمثيل التجاري وعدم الإيحاء بدعم Meta أو تأييدها، والاحتفاظ بسجلات موافقات المستلمين، ومتطلبات دولة العميل/الجهة. مصادر مراجعة خارجية (ليست بديلًا عن Legal):
- WhatsApp Business Messaging Policy: https://whatsappbusiness.com/policy/
- WhatsApp Business App Terms: https://www.whatsapp.com/legal/WhatsApp-Terms-for-WhatsApp-Business-App
- WhatsApp Business Solution Terms: https://www.whatsapp.com/legal/business-solution-terms/

## 5. تصميم نموذج البيانات — proposal للمراجعة قبل أي migration

**لا migration في P0.** في حزمة P1 نضيف schema جديدًا بعد جرد تعارضاته مع الجداول القائمة:

1. **whatsapp_openwa_account_policy_acceptances**: سجل versioned account consent مؤرخ؛ account_id، accepted_policy_version، accepted_locale، accepted_text_digest، accepted_by (auth user)، accepted_at، revoked_at/revoked_by أو أحداث سحب append-only، original/current revision. لا مفاتيح ولا محتوى رسائل ولا أرقام هواتف.
2. **whatsapp_openwa_connection_activation**: حالة تشغيل مفصولة عن session status وعن TEST pilot: account_id، connection_id، status (disabled/enabled/suspended)، policy_version، updated_by، updated_at، revision للتزامن. تحقق من وجود connection من نفس الحساب والمزود وغير مؤرشف. Unique per account+connection وقيود server/RPC.
3. **whatsapp_openwa_activation_events**: دفتر append-only (actor, action, reason_code, old/new state, policy_version, UTC, correlation id). INSERT/SELECT المسموح بهما للخدمة فقط عند الحاجة؛ لا UPDATE/DELETE للعميل؛ لا أسرار.
4. ثبّت نص/نسخة الوثيقة المنشورة في code أو جدول immutable content registry؛ خزّن digest موثقًا وversion، وليس checkbox boolean فقط. تغيّر السياسة الجوهرية ⇒ needs_reacceptance.
5. عدم وجود row/خلل استرجاع/اختلاف نسخة/تعذر تحميل policy ⇒ **fail closed** في Production. لا إنشاء تلقائي للموافقة أثناء session creation أو الترحيل.
6. migrations جديدة additive مع FK/indexes وRLS/grants/rpc وSQL smokes. راجع NOTE-001: لا SECURITY DEFINER/owner bypass غير مراجع؛ service_role لا يمنع التحقق من tenant بالبرمجة والدالة.

**تفويض مقترح:**
- Owner: قبول السياسة والسحب والإلغاء، الاطلاع على audit.
- Admin: مشاهدة حالة الموافقة وتشغيل/إيقاف الجلسة بعد قبول Owner والسياسات ووجود feature gate، دون توقيع نيابة عن Owner.
- Agent/Viewer: metadata التشغيل الضرورية لواجهات اختيار الاتصال فقط؛ ممنوع رؤية نصوص audit التفصيلية والـtokens والمفاتيح/QR أو تغيير الموافقة.
- System workers: فحص effective admission في كل dispatch وفق scope، بلا قدرة على قبول أو تفعيل.

## 6. سياسة فعالية السماح والإرسال — المصدر الوحيد للحكم

**فعالية السماح بالإرسال عبر OpenWA** تُحسب على الخادم (وليس بالاعتماد على حالة زر UI وحدها)، قبل provider call، وفق الشروط التالية مجتمعة:

~~~text
isOpenWA && accountScoped && connectionScoped && notArchived
AND sessionReady AND validAccountPolicyAcceptance(currentVersion)
AND connectionActivationEnabled
AND environmentReleaseGateAllowed (PRODUCTION defaults OFF)
AND notManualPaused AND notCircuitRestricted
AND guardrailsAndWorkloadPermissionPass
AND existingRecipientConsentAndMessagingPolicyPass (where applicable)
=> outbound may attempt dispatch
~~~

- في **Production** يجب أن يكون feature gate **OFF افتراضيًا**؛ تفعيله مستقبلاً فقط بعد W09/owner approval وW07 Product/Legal sign-off وW06/W05/W03/W04 gates.
- في **TEST** نحافظ على دلالة pilot_enabled الحالية للعمل التطويري؛ لا نعيد استخدامه كحالة موافقة إنتاجية، ولا نفتح أي Production flag من أجل تمرير TEST. خطة rollout محلية: ننشئ policy/read-only state والتوثيق ثم نفعّل حظرًا تدريجيًا على سيناريوهات الاختبار المعزولة فقط بعد اختبارات عدم الانحدار؛ لا نكسر sessions TEST القائمة دون مراجعة queue/backlog.
- enforcement في المسار المشترك الخاص بـ OpenWA في **router.ts / GuardedOpenWATransport** مع fail-closed pre-dispatch policy. يُعاد التحقق بعد الحجز/الانتظار وقبيل inner.send لتقليل السباق مع revoke. لا وعد بإلغاء provider call بدأت بالفعل.
- **لا تغيّر** Meta transport، ولا inbound signed webhook/ACK/read-only reconciliation مع توقف outbound؛ هذه القنوات مطلوبة لتسوية رسائل سابقة.
- حقول API تعرض **effective state + safe reason code**، لا raw SQL error/credential/token. عقود stable: consent_required, consent_outdated, connection_disabled, environment_not_authorized, manual_paused, session_not_ready, policy_unavailable.
- رقابة شاملة على entrypoints الفعلية (manual text/media/reply, broadcast, automation, agent task, service promotion, internal jobs, public API). عدم وجود direct OpenWA send bypass يُثبت باختبارات source/route.
- تجنب race عند التفعيل/السحب: transactional compare-and-set version + locks وحماية idempotency. اختبار busy worker + revoke + pending وnonterminal ambiguous sends.

## 7. مراحل التنفيذ التفصيلية (لا نبدأ runtime إلا بطلب تنفيذ)

| الحزمة | نطاق التنفيذ | مخرجات تقنية | بوابة التحقق |
| --- | --- | --- | --- |
| **W07-00 Baseline/contract** | حصر entrypoints، UX الحالية، الأدوار، consent/recipient، policy compliance، إغلاق القرارات | architecture/ADR + قائمة مخاطر + اختبار حصر bypass | مراجعة Product/Security للمتطلبات |
| **W07-01 Copy & legal** | نصوص AR/EN، سياسة رسمية/غير رسمية، سياسة الدعم والخصوصية واحتفاظ audit | versioned copy pack + policy digest + legal checklist | **Product/Legal reviewed** قبل ظهور النصوص لعملاء Production |
| **W07-02 Data & audit** | account consent وper-connection activation وappend-only ledger | additive migrations + atomic tenant-scoped RPC + rollback design + SQL/RLS smoke | clean migration replay + negative tenant/privileges |
| **W07-03 Control APIs** | read consent/effective state؛ accept/revoke/activate/suspend بإذن مناسب وidempotency | admin routes، typed schema، structured safe reason codes، no-store | route tests 401/403/409/422/5xx وfail-closed |
| **W07-04 Transport gate** | إنفاذ موحّد قبل dispatch على كل workloads دون Meta regression | admission helper، guardrail integration، dispatch-attempt proof | no OpenWA send without consent + no Meta regression |
| **W07-05 UX** | cards، disclosure، acceptance stepper، per-session controls، activity history | reusable polished components + Arabic/English + a11y | UI/component + locale tests + keyboard/RTL review |
| **W07-06 Support ops** | FAQ، stop/revoke، disconnect/re-QR/escalation، support status بدون PII | support runbook + customer-facing knowledge copy + incident matrix | security/product review وrecovery scenario tabletop |
| **W07-07 Regression/CI** | concurrency, stale policy, duplicate clicks, tenant isolation, queued work, unknown errors, Meta parity | unit/route/SQL tests, lint/typecheck/build, migration clean replay | exact-HEAD CI **completed/success** |
| **W07-08 Live acceptance (DEFERRED)** | permitted bounded TEST tests، provider-backed handling، Product/Legal approvals | QA report + release decision evidence | يُنفّذ فقط بإذن منفصل؛ لا إغلاق إنتاجي الآن |

**الترتيب المقترح:** W07-00 → W07-01 (draft) بالتوازي مع W07-02 design → W07-03 → W07-04 → W07-05 → W07-06 → W07-07؛ W07-08 لاحقًا. لا يُغلق SOF-54 بوصف “production ready” عند نجاح الاختبارات المحلية فقط.

### تفاصيل اختبارات الانحدار الإجبارية

| السيناريو | النتيجة المتوقعة |
| --- | --- |
| حساب جديد/OpenWA session جديدة بدون موافقة | لا outbound عبر OpenWA، Meta unaffected |
| Owner قبل إصدار سياسة قديم | يحتاج قبول إصدار جديد عند تغير النص المعتمد؛ لا إرسال |
| Admin أو Agent يحاول قبول الشروط بدل Owner | 403/denied + no mutation |
| Agent يطلب تفعيل اتصال أو QR | denied وبدون credential disclosure |
| Tenant A يحاول قراءة/تعديل consent أو connection لـTenant B | denied بدون metadata leak |
| اتصال موجود لحساب A لكن connection_id مزور | fail-closed وعدم استخدام service_role لتجاوز scope |
| تفعيل مرتين/parallel requests | حالة واحدة، أحداث idempotent، لا dispatch |
| سحب الموافقة بالتزامن مع إرسال مؤجل | يفشل قبل provider إذا لم يبدأ؛ in-flight يستمر فقط وفق الواقع، reconciliation مستقل |
| policy DB unavailable/unknown version/missing row | deny outbound، لا open fallback |
| حالة gateway READY وpilot OFF لكن production flag OFF | production OpenWA outbound blocked |
| Pilot TEST allowed لكن connection operational consent missing (حيث W07 gate مفعل للاختبار) | denied؛ لا يعتبر Pilot موافقة |
| manual STOP أو circuit breaker بعد قبول الموافقة | denied؛ الموافقة لا تلغي السلامة |
| Meta inbound/outbound/template وغياب connectionId | يبقى على Meta مع إثبات parity |
| Broadcast/automation/agent/manual/media/API | جميعها تمر بالسياسة نفسها |
| webhook inbound duplicate/ACK أثناء suspension | معالجة آمنة لتسوية الموجود؛ لا outbound replay |
| CSS/RTL/mobile/keyboard/invalid form | واجهة مستقرة وواضحة، بدون ازدحام أو تحذيرات مكررة |

## 8. مصفوفة الدعم الفني والتصعيد

| الحدث | ما يراه المسؤول | إجراء المشغل الآمن | ما لا يحدث تلقائيًا |
| --- | --- | --- | --- |
| انقطاع جلسة/QR مطلوب | disconnected / reconnect required | فحص health ثم إعادة ربط Admin فقط بعد تحديد جلسة واحدة | لا إنشاء جلسة بديلة/نقل رسائل |
| خطأ/قيود WhatsApp | restricted + warning | suspend outbound، مراجعة السبب والسياسات، تصعيد دعم | لا bypass/إرسال متكرر |
| consent revoked/terms stale | restricted reason | إيقاف send، توضيح إعادة القبول، audit | لا إعادة تفعيل ذاتية |
| ambiguous send / timeout | requires_reconciliation | native correlation + حفظ دليل وعدم التخمين | لا blind resend |
| webhook/ACK delayed | degraded | مراجعة unified intake والـdedup/leases | لا تزوير delivery status |
| اشتباه تسريب مفتاح/وصول | incident urgent | stop/suspend، تدوير آمن، مراجعة Security وtenant | لا إظهار key أو QR في رسالة الدعم |
| Meta service functional but OpenWA down | OpenWA unavailable, Meta still configured | اختيار يدوي صريح لاتصال مطابق مؤهل عند الحاجة | لا auto-failover أو silent number swap |

- الدعم يشرح المسؤوليات وحدود الاستعادة/النسخ، ولا يعد بتعافٍ مثبت قبل W06.
- **SLA/RTO/RPO** المقترحة غير معتمدة ولا تُعرض كضمان؛ في الحادث الخطير stop/containment ثم audit/reconciliation.
- تبليغات العميل وحالات الشكوى يجب أن تكون مجرد reason codes وحالة تشغيل؛ لا محتويات رسائل أو بيانات سرية.

## 9. شهادات جودة وDefinition of Done

**Implementation complete:** جميع W07-00..W07-07 تنفذ وفق العقود بعد جرد الكود، code review، لا نظم موازية، migrations additive، status/copy/API/DB/UX ودليل support موجودة.

**CI verified:** exact HEAD completed/success في Lint، TypeScript، Vitest، Next build، SQL migration replay/smokes، security negative tests، Meta regression، no-openwa-by-default / no-bypass tests. لا يُستنتج من CI مصادقة قانونية.

**TEST verified:** تطبيق migration على Supabase TEST في وقت مرخّص، اختبارات UI/DB isolation وpolicy lifecycle وworker cross-path، مع إثبات أن سحب الموافقة يمنع الإرسال الجديد بعد التحقق دون إعادة إرسال. هذه حزمة منفصلة عندما يُسمح ببدء TEST الحي.

**Live acceptance complete:** اختبار محدود مع مزود حقيقي/جلسة مخوّلة، مسارات receiving/outbound/revoke والدعم، مع evidence مخفي المعرفات، وProduct/Legal/Security signed review. مؤجل الآن.

**Production ready:** يتطلب ما سبق **وبالإضافة** إلى OW14-W03/W04/W05/W06/W08 وOW-12/13، NOTE-001، الموافقات المستقلة وقرار OW14-W09 GO. هذا لا يمكن إعلانه عند إغلاق كود W07 وحده.

### DoD ticket SOF-54 granular checklist
- [ ] Current HEAD/architecture inventory + reviewed ADR.
- [ ] Versioned policy wording AR/EN + named Product/Legal approval أو إبقاء نشرها محجوبًا.
- [ ] Consent/activation schema with correct account/connection scope, permissions and append-only audit.
- [ ] Owner-only risk acceptance; Admin+ guarded operational activation; Agent/Viewer denied.
- [ ] Production OpenWA default OFF, Meta parity stable, TEST Pilot explicitly independent.
- [ ] Every outbound workload enforces gate before provider API call, including concurrency/revocation tests.
- [ ] UI shows effective state/disable reasons clearly, responsive, RTL/LTR, accessible.
- [ ] Support FAQ/escalation/stop/revoke/QR/ambiguous outcomes documented.
- [ ] Local tests + migrations clean replay + latest exact-HEAD CI completed/success.
- [ ] Later authorized TEST provider-backed acceptance, QA and approvals recorded separately.
- [ ] No Production deploy, server secrets disclosure, unreviewed migration or WhatsApp outbound test caused by planning.

## 10. التبعيات والتنسيق مع W06 والبيئات

**OW14-W06 / SOF-53:** **Deferred / paused after one real read-only VPS measurement**. لا ننفذ backup/restore/remote benchmark الآن. يبقى سجل القياس في docs/operations/OW14_W06_CAPACITY_BACKUP_TEST_BASELINE.md؛ يجب إكمال encrypted backup وisolated restore وRTO/RPO قبل GO. لا نحول التأجيل إلى Done.

**Windows local-first:** التحقق من الفرع وHEAD، كتابة تصميم/UX/SQL/tests وتشغيل npm lint/typecheck/test/build محليًا أو CI. أي تغييرات Supabase TEST schema أو التشغيل على VPS أو live provider tests تحتاج إذنًا منفصلًا مع نموذج rollback؛ لا إرسال حقيقي ناشئ عن اختبار وحدات.

**VPS:** لا git pull ولا docker build ولا scheduler stop/start ولا OpenWA session/URL/webhook changes ضمن إعداد هذه الخطة. دليل العودة للسيرفر:
[HOSTINGER_TEST_VPS_OPERATIONS_AND_RELEASE_RUNBOOK.md](../../docs/deploy/HOSTINGER_TEST_VPS_OPERATIONS_AND_RELEASE_RUNBOOK.md).

**التوافق backward compatibility:** لا مسار Meta جديد، لا downgrade للـmigrations، لا تغير لبيانات ACK، لا إلغاء صلاحيات لازمة في TEST دون خطة cutover. حال النشر بعد اكتمال W07 يحتاج إصدار WACRM وDB منسجمين، phased toggle، TEST smoke ثم قرار مستقل.

## 11. مسؤوليات الموافقة والخطوة الهندسية التالية

| المجال | المقترح | المطلوب قبل الإغلاق |
| --- | --- | --- |
| Engineering | source baseline + transport/DB/UX tests | exact SHA + CI/TEST evidence |
| Security/DB | RLS/role/provider threat model | sign-off على schema وaudit وrotation |
| Product | wording/feature contract/policy changes | sign-off على UX وحالات المخاطر |
| Legal/Compliance | official WhatsApp policy/legal review | نصوص مُعتمدة ونسخة سياسة محددة |
| Operations/Support | incident and re-QR manual recovery | approved support/stop ownership |
| QA/Release | acceptance evidence and GO gating | authorized TEST pilot + signed independent release |

**أول حزمة للتنفيذ عند التكليف:** **W07-00 — Source/ADR + versioned consent contract** ثم **W07-01** نصوص عربية/إنجليزية قابلة للمراجعة؛ بعد تثبيت العقود نبدأ W07-02 migration جديدة دون تشويش Pilot أو حماية Meta.

---
**مستوى هذه الوثيقة:** implementation plan authored + repository source audit؛ **W07 implementation not started**، TEST/Live/Production not verified.


## 2026-11-20 — W07-00 / W07-01 implementation checkpoint

- **W07-00 architecture and permission contract:** docs/architecture/OW14_W07_00_PROVIDER_CONSENT_AND_ACTIVATION_CONTRACT.md. Reuses the current tenant-scoped router, OpenWA guardrails/session administration, unified send engine and Meta default. Proposes owner-only policy acceptance/revocation and admin+ connection activation; TEST Pilot and recipient consent remain independent. Role proposal is unit-tested but does NOT enforce runtime authorization until W07-03.
- **W07-01 bilingual draft policy:** docs/product/OW14_W07_01_PROVIDER_RISK_COPY_AND_SUPPORT_REVIEW.md and the versioned code catalogue src/lib/whatsapp/transport/openwa/operational-policy-draft.ts. This copy remains a **Product/Legal draft**, not signed customer terms.
- **Informational UI:** src/components/settings/whatsapp-provider-choice-preview.tsx placed before existing provider settings; responsive Meta/OpenWA cards, localized risk review dialog, three clear future activation steps and support FAQ. Screen records NO consent and has NO activation action; existing Meta/OpenWA/TEST Pilot runtime is unchanged.
- **Tests:** src/lib/whatsapp/transport/openwa/operational-policy-draft.test.ts asserts no default production enablement, role boundaries, localization and risk disclosures. Latest exact-HEAD CI outcome remains an independent gate.
- **Next packages:** W07-02 additive schema/audit, W07-03 real authorized APIs, W07-04 shared outbound enforcement and W07-05 effective-state UI. Do not claim W07 is operational or production-ready from a draft preview.
- **Environment:** Windows-first development; NO VPS/Production deployment, remote migration or live WhatsApp send for this checkpoint. W06 remains deferred.

## 2026-11-20 — W07-02 implementation checkpoint (schema, NOT hosted TEST)

- Additive migration 204_openwa_operational_consent_activation.sql creates server-only approved policy version registry (empty), account consent state and append-only audit, per-connection activation state and append-only audit, and tenant-composite FK. No seed, no operational send, no session modification.
- Account-owner only accept/revoke RPC and admin+ connection enable/disable/suspend RPC use SECURITY INVOKER, service_role EXECUTE only, actor membership verification, account-first locks, optimistic revision and scoped request UUID idempotency. Activation binds to exact accepted_event_id, so revocation/reacceptance cannot silently re-enable prior approval.
- CI-only synthetic SQL smoke in supabase/ci/openwa-operational-consent-activation-smoke.sql verifies RLS/grants, no live policy, privilege/tenant negatives, actor roles, cross-account FK, stale revision, retry and re-accept state. Wired to GitHub Migrations clean replay.
- Detail: docs/architecture/OW14_W07_02_CONSENT_AUDIT_SCHEMA_AND_API_HANDOFF.md.
- W07-03 Next.js APIs and W07-04 real provider send-time enforcement are NOT yet implemented. Existing W07-01 preview remains read-only. No hosted Supabase TEST migration or VPS deployment was authorized. Exact-HEAD Migrations CI completed/success is still required before calling this CI verified.

## 2026-11-20 — W07-02 verified local clean-replay after least-privilege corrections

- Migration: supabase/migrations/204_openwa_operational_consent_activation.sql (no seed; no hosted Supabase TEST application).
- SQL smoke: supabase/ci/openwa-operational-consent-activation-smoke.sql, added to the existing Migrations workflow; synthetic fixture is rolled back and never contacts WhatsApp.
- GitHub Migrations clean replay **completed/success** for code HEAD **f7d7eb47637b31d91d5e6f342a1e59ec756a6d1d**: https://github.com/e-proo/wacrm/actions/runs/44661783357
- Security test feedback corrected by granting only the three required profile membership columns and six read-only connection columns to service_role; neither authenticated nor anon got new privileges. W07 account advisory transaction lock replaces an accounts row UPDATE lock. Rechecks still verify tenant and actor in SQL.
- Model and API handoff: docs/architecture/OW14_W07_02_CONSENT_AUDIT_SCHEMA_AND_API_HANDOFF.md
- **Evidence level:** W07-02 implementation complete + **clean migration CI verified**. Application CI result, Supabase TEST application, API auth/tenant tests, live acceptance and Product/Legal approval are separate gates; no Production or VPS change.
- **Next:** W07-03 owner/admin authenticated APIs, then W07-04 shared OpenWA outbound enforcement, then W07-05 functional UI. Current W07-01 preview remains a non-mutating draft.

## 2026-11-20 — W07-03 authenticated control APIs (implementation checkpoint)

- Source: src/lib/whatsapp/transport/openwa/operational-control-api.ts and two admin-only API routes:
  - GET/POST /api/whatsapp/connections/openwa/operational-policy
  - POST /api/whatsapp/connections/openwa/{connectionId}/operational-activation
- Server-only requireRole('owner') for account policy accept/revoke; requireRole('admin') for connection enable/disable/suspend and read-only state. Context comes from Supabase auth.getUser() and RLS-scoped profiles/account, NEVER client-supplied actor_id or account_id. Existing service-role-only W07-02 SECURITY INVOKER RPCs recheck membership/connection scope atomically.
- Strict 4 KiB JSON payload, exact permitted keys, UUID request id + expected revision, mandatory trusted same-origin header, no-store, redacted error and audit responses, stable safe reason codes and HTTP statuses, idempotent retry semantics.
- **Default closed:** WACRM_W07_CONTROL_WRITES_ENABLED is off; accept and enable are blocked until later deliberate rollout after W07-04 and reviewed policy. Owner revoke, admin/owner disable and suspend remain safe containment operations. No policy is pre-approved/seeded.
- GET always reports operational_gate=pending_w07_04 and production_send_authorized=false, even if a requested activation row says enabled. Activation never starts sessions, dispatches queued messages, bypasses TEST Pilot, retries provider outcomes or switches Meta.
- Unit and route tests cover roles, cross-tenant scoped calls, request spoofing, origin, oversized payload, draft rejection, DB failure, conflict/retry and safe output. New detail: docs/architecture/OW14_W07_03_AUTHENTICATED_CONTROL_API_AND_SECURITY_EVIDENCE.md.
- W07-04 shared provider pre-send enforcement and W07-05 functional UI are still required. No VPS or hosted Supabase mutation, no live WhatsApp testing and no Production GO is implied.

## 2026-11-20 — W07-04 shared OpenWA outbound operational admission implementation

- W07-04 is enforced only within the existing OpenWA transport path; Meta remains official/default and both inbound and reconciliation remain unchanged.
- New W07 gate in src/lib/whatsapp/transport/openwa/operational-consent-gate.ts: non-TEST release flag default OFF, current reviewed policy version/digest, accepted account consent, exact current event-bound per-connection activation, verified audit event and tenant-scoped ready session. All unavailable evidence fails before provider dispatch.
- GuardedOpenWATransport checks BEFORE capacity reservations, then rechecks emergency pause/circuit after reservation when W07 is active. Raw OpenWA adapter performs the FINAL consent/session identity check immediately before text/media provider call; direct calls cannot bypass it. Uncertain provider errors retain existing reconciliation, W07 denials have providerDispatchAttempted=false and are NOT attributed as provider failures.
- The pinned Supabase TEST project keeps its existing Pilot path during Windows-local development; WACRM_W07_TEST_GATE_MODE=enforce exercises W07 in TEST when explicitly authorized. Invalid TEST flags fail closed. All non-TEST/unknown environments require WACRM_OPENWA_PRODUCTION_RELEASE_ENABLED=true plus current, versioned consent and activation. This production release flag must NEVER be switched on before OW14-W09 GO.
- Exact-scoped role/consent activation and RLS are backed by W07-02 migration 204. No new or applied migrations modified for W07-04. W07-03 admin GET now truthfully reports installed gate mode/release setting and never promises actual recipient-specific send permission.
- Unit/integration tests: operational-consent-gate.test.ts and operational-consent-integration.test.ts; plus existing guardrail/router/adapter tests preserving Meta and Pilot behavior. Negative cases include cross-tenant, stale version/event, revoked consent, suspended state, missing DB, release OFF, session rotation/identity, emergency STOP, media and five workloads.
- Engineering details and exact DoD: docs/architecture/OW14_W07_04_UNIFIED_OPENWA_PRE_DISPATCH_CONSENT_GATE.md.
- **Status:** code prepared pending exact-HEAD CI; NOT hosted TEST verified, NOT live accepted, NOT Product/Legal signed, NOT Production ready. No VPS or hosted DB mutation, no real send. W07-05 remains functional management UX and W06 remains deferred.


## 2026-11-20 — W07-04 exact-implementation CI verification

- Implementation SHA 561d49377525cad8d093d1767426aac02d16ca6d, CI https://github.com/e-proo/wacrm/actions/runs/44745635876 **completed/success** on exact SHA; Lint, Typecheck, Vitest, Meta/OpenWA regression and Build passed. W07-04 status: **implementation complete + CI verified**.
- Real hosted TEST application and live acceptance are NOT complete; W07-02 migration 204 is not applied to hosted TEST, legal policy is not published/approved, production release flag remains OFF, W07-05 polished functional UI pending, W06 deferred. No VPS/Production deployment.
- See docs/architecture/OW14_W07_04_UNIFIED_OPENWA_PRE_DISPATCH_CONSENT_GATE.md for implementation proofs, TEST legacy separation, W09 release gate and rollback safety.

## 2026-11-20 — W07-05 tabbed WhatsApp administration, operational consent and audit UI

- **Information architecture:** Settings → WhatsApp is now a structured six-tab admin workspace: Overview, Meta, OpenWA Sessions, TEST Pilot/Limits, Consent & Audit, Delivery Review. Existing controls are preserved and routed to their appropriate tab rather than stacked in one large settings screen. Session actions deep-navigate to the relevant Pilot/Review tab for the same connection; mobile horizontal tab navigation and Arabic RTL/English labels are supported.
- **W07-05 control center:** src/components/settings/openwa-operational-control-center.tsx consumes existing account-scoped GET and POST W07-03 APIs; shows real current owner consent/version, requested connection activation, readiness/reasons, backend W07 send/release status and latest bounded audit events. Confirmation dialog required for owner acceptance/revoke and admin+ activation/suspend/disable. Never presents an enabled requested state as message-specific send authorization; no new transport or worker.
- **UI behavior:** 503/missing migration 204 is explicit and fail-closed; no fake zero rows. Writes have stable UUID idempotency request ID and expected revision. Unknown network result retains request ID until safe refresh/retry. Server-side account/actor/tenant checks remain authoritative.
- **Legal terms fence:** src/lib/whatsapp/transport/openwa/approved-policy-catalog.ts has an intentionally EMPTY published catalog, signed AR/EN copy must be added only with Legal/Product signoff and its SHA-256 matching a separately approved DB policy version. API GET returns matching content only, and accept POST refuses if the exact reviewed text is not published — even if WACRM_W07_CONTROL_WRITES_ENABLED=true. Existing W07-01 draft can only be read and never accepted.
- **Review UX:** existing single account-level OpenWA outbound review hub is preserved and per-session deferred reconciliation moved into the selected connection in the Delivery Review tab (no duplicated card per session). Existing QR/credentials remain admin-only; no exposed keys/JIDs or provider receipt claims.
- **Scope and evidence:** no new migration, no hosted Supabase TEST application, no VPS/Production changes, no WhatsApp live test. UI tests/source contract, bilingual copy parity and approved catalog/API authorization tests plus full exact-HEAD CI required; Product/Legal and manual visual/keyboard RTL QA are independent acceptance gates.
- **Design and rollout details:** docs/architecture/OW14_W07_05_WHATSAPP_ADMIN_TABBED_CONTROL_CENTER.md.
- **NEXT:** W07-06 support/help documentation and W07-07 broader regression/role audit, then W07-08 bounded TEST acceptance. W06 remains deferred; NOTE-001 and W09 release blockers remain.
