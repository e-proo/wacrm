# برومبت المرحلة 05 — Embeddings وتجربة الإعدادات

```text
نفّذ المرحلة 05 فقط بعد قبول adapters والاتصالات. الهدف فصل Chat عن Embeddings بأمان، تطبيق قيد الأبعاد وإدارة re-index، ثم بناء UX متكامل لاكتشاف/اختيار النماذج. لا تغيّر بُعد قاعدة البيانات عشوائياً.

الخطوة الأولى الإلزامية:
- أعد التحقق من schema/RPC/index الفعلي للـ pgvector ومن كل موضع يثبت النموذج أو 1536.
- قدم قرار تنفيذ قصير: (أ) revision مزدوجة مع atomic activation، أو (ب) تعطيل semantic مؤقتاً ثم full re-index ثم تفعيل. اختر الأبسط الآمن الذي يناسب بنية المشروع، وسجل أي انحراف في ADR.

Backend — Embeddings:
- استخدم adapter `embed` العام للمزوّدات التي تدعمه فعلاً.
- افصل embedding_connection_id/model عن chat connection/model.
- مرر dimensions option فقط إذا كان البروتوكول/المزوّد يدعمه رسمياً؛ لا تفترض.
- test embedding بإدخال ثابت غير حساس، ثم تحقق من عدد النتائج، القيم finite، وطول كل vector.
- لمسار الفهرس الحالي اقبل 1536 فقط.
- لا truncate ولا pad ولا mix.
- احفظ model/dimensions/revision وحالة التوافق/آخر تحقق.
- تغيير connection/model/dimensions/options يجعل revision جديدة ويطلب re-index.
- حافظ على lexical fallback، وعلى semantic revision السابقة حتى نجاح الجديدة إن كان التصميم يسمح.
- batch/retry على مستوى job وبحدود واضحة؛ لا retry loop غير محدود.
- backfill مفتاح/نموذج OpenAI embeddings الحالي من دون طلب إعادة إدخال إن أمكن بأمان.

Backend — Config/API:
- تحديث config ذرّي، والتحقق من ملكية connection للحساب.
- لا تفعل semantic config غير مختبر.
- status واضح لـ pending/building/ready/failed أو البديل المحافظ.
- لا تحذف vectors/revision قديمة في الإصدار نفسه.

Frontend — Connections:
- قائمة/إنشاء/تعديل/تعطيل/حذف الاتصالات وفق الصلاحيات.
- preset selector، root read-only للثابت وcustom فقط عند السماح.
- key masked، فارغ عند edit، ولا يرسل placeholder.
- زر Verify & load models، مع loading/success/error/request ID الآمن.

Frontend — Models:
- searchable select من normalized catalog.
- manual model ID متاح دائماً.
- عرض freshness timestamp وstale/error/unsupported discovery.
- saved model الغائب يبقى ظاهراً ومختاراً مع شارة.
- refresh لا يغير اختيار المستخدم تلقائياً.
- capability supported/unknown مع لغة واضحة، لا تجعل unknown failure.
- Test selected model فعل صريح مع تنبيه تكلفة صغيرة.

Frontend — Chat/Embeddings:
- selectors مستقلة.
- نموذج embeddings يعرض requirement 1536 ونتيجة observed dimensions.
- تغيير الإعداد يعرض re-index impact وحالته.
- تعطيل semantic لا يعطل Chat أو lexical knowledge search.
- حافظ على system prompt/auto-reply/handoff UX الحالي.

i18n/accessibility:
- حدث كل locale موجود في الفرع ولا تكتب نصوص JSX ثابتة.
- labels/help/errors/statuses مترجمة.
- keyboard navigation، focus management، aria/live status، وعدم الاعتماد على اللون وحده.

الاختبارات الإلزامية:
- embed adapters ordering/malformed/non-finite/dimension 1536 vs mismatch.
- no DB/RPC write on mismatch.
- revision change وactivation/fallback وعدم mix.
- backfill account with separate embeddings key.
- API ownership وsafe DTOs.
- UI: masked key, fixed/custom root, empty/stale/manual/saved-missing catalogs.
- Chat وEmbeddings من اتصالين مختلفين.
- refresh/error يحافظ على model.
- i18n keys لكل locales وaccessibility الأساسية.
- OpenAI/Anthropic draft/auto-reply وknowledge regression.

لا تفعل:
- لا تغير vector column إلى dimension أخرى في المكان.
- لا تفعّل أي نموذج بناء على الاسم فقط.
- لا تجلب models عند كل render.
- لا تمسح المفتاح عند field فارغ.
- لا تحذف القديم أو تبدأ contract phase.

شغّل التحقق الكامل والبناء. اكتب phase-05-embeddings-ux.md وفق القالب، وضمنه مخطط revision/re-index، counts/rollback، screenshots أو وصف حالات UI وفق أدوات المشروع، ونتائج كل اختبار. توقف ولا تبدأ المرحلة 06.
```

## بوابة القبول

- لا vector مخالف يصل إلى قاعدة البيانات.
- تغيير embedding config له مسار re-index صريح وآمن.
- UI يحتفظ بالاختيار ويتيح manual entry.
- كل الأسرار تبقى server-side وكل locales محدثة.

