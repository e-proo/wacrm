# تكامل العملات مع بقية الخدمة — Migration 053

> **التاريخ:** سبتمبر 2026
> **الفرع:** `phase-2/services-coverage-rates`
> **المرجع:** `supabase/migrations/053_currency_integration.sql`

هذا التوثيق يشرح كيف أصبحت خدمة أسعار الصرف وقواعد التسعير تستخدم جدول العملات (`currencies`) بشكل متكامل، بعد ملاحظتك بأن حقل BASE/QUOTE كان نصاً حراً.

---

## 1. ما كان ينقص

بعد Migration 052، كان عندنا:
- ✅ جدول `currencies` للعملات النشطة.
- ✅ 4 عملات افتراضية (SAR/USD/YER/YER_OLD) لكل حساب.
- ✅ UI لإدارة العملات.

لكن كانت هناك فجواتان:
1. **أسعار الصرف** تستخدم `text` حر للحقول `base_currency` و `quote_currency` — لا ربط إلزامي بالـ catalog.
2. **قواعد التسعير** تستخدم `text` حر للحقول `fee_currency` و `input_currency`.

**النتيجة:** المستخدم يستطيع كتابة `XYZ` كعملة في الأسعار، رغم عدم وجودها في الـ catalog.

---

## 2. الحل في Migration 053

### 2.1 أعمدة FK جديدة (nullable، additive)
- **`exchange_rates.currency_id_base` / `currency_id_quote`**
- **`exchange_rate_history.currency_id_base` / `currency_id_quote`**

كلها nullable. الـ rows القديمة تبقى صالحة (FK فارغ). الـ rows الجديدة تُملأ تلقائياً عند النشر.

### 2.2 Backfill
الـ migration يحوي `DO $$ ... LOOP` يملأ الـ FK بناءً على تطابق الـ code في الـ catalog:

```sql
UPDATE exchange_rates r
   SET currency_id_base = c.id
  FROM currencies c
 WHERE c.account_id = r.account_id
   AND c.code = r.base_currency;
```

نفس النمط لـ `quote_currency` و history.

### 2.3 تحديث `publish_exchange_rate_version`
الـ RPC تُحدَّث لتملأ `currency_id_base/quote` تلقائياً قبل كتابة الـ history. هذا يضمن أن أي نشر جديد يُسجَّل مع FK.

---

## 3. مكونات الـ UI الجديدة

### 3.1 `CurrencyDropdown` (مكون مشترك)
- **مسار:** `src/components/services/currency-dropdown.tsx`
- **يجلب** العملات النشطة عبر `GET /api/currencies/active`.
- **يعرض** dropdown مع كل عملة نشطة: `code (symbol) — display_name`.
- **خيار custom**: لو الـ code الحالي غير موجود في الـ catalog، يحوّل المستخدم إلى input نصي تلقائياً.

### 3.2 زر التعديل في `CurrenciesPanel`
- **زر "Edit"** على كل بطاقة عملة.
- **يفتح** نموذج تعديل مدمج (inline edit):
  - display_name
  - kind (iso_4217 / historical / local)
  - symbol
  - decimal_digits
  - notes
- **يحفظ** عبر `PATCH /api/currencies/[id]`.
- **ما يمكن تعديله**: لا يمكن تعديل الـ code (مفتاح أساسي منطقي).

### 3.3 تكامل `ExchangeRateBooksPanel`
- حقل BASE/QUOTE في كل صف أسعار → **CurrencyDropdown**.
- الحقل يحترم حالة الإصدار (draft → مفتوح، published → معطل).
- لو المستخدم اختار عملة نشطة، تظهر في الأسعار.
- لو أراد كتابة عملة غير معرَّفة (legacy data)، يستخدم خيار "Other" النصي.

### 3.4 تكامل `PricingRulesPanel`
- حقل fee_currency و input_currency → **CurrencyDropdown**.
- نفس منطق الحماية (لا تعديل للقواعد المنشورة).
- خيار custom للنصوص القديمة.

---

## 4. سير العمل الجديد

### 4.1 إضافة سعر صرف لزوج جديد
1. افتح `/services` → تبويب "أسعار الصرف".
2. اختر/أنشئ دفتر + إصدار draft.
3. في محرر الأسعار، **BASE و QUOTE الآن قوائم منسدلة**:
   - اختر `SAR` للـ BASE، `YER` للـ QUOTE.
   - إذا كانت العملة التي تريدها معطّلة، اذهب لتبويب "العملات" وفعّلها.
   - إذا لم تكن معرَّفة أصلاً، استخدم خيار "Other" لكتابة الكود مباشرة.
4. أدخل buy/sell/min/max.
5. تحقق → انشر.

### 4.2 تعديل عملة موجودة
1. افتح تبويب "العملات".
2. اضغط "Edit" على البطاقة.
3. غيّر display_name أو symbol أو notes أو decimal_digits.
4. اضغط "Save changes".

### 4.3 إضافة عملة جديدة
1. تبويب "العملات" → نموذج "Add a currency".
2. ادخل code + display_name + kind.
3. اضغط "Create".
4. العملة الجديدة تظهر تلقائياً في dropdowns الـ BASE/QUOTE/fee/input.

---

## 5. الـ API الجديدة

| المسار | الفعل | الوصف |
|---|---|---|
| `GET /api/currencies/active` | read | قائمة العملات النشطة فقط (للـ dropdowns). |

نفس المسارات السابقة للـ CRUD الكامل.

---

## 6. الاختبارات

`src/lib/services/currencies/crud.test.ts` — 11 اختبار (موجود مسبقاً).

اختبار جديد للـ `active-list.ts`:
- (سيُضاف في الـ push التالي) تحقق من تنسيق الـ response.

---

## 7. ضمانات التكامل

- [x] كل عملة جديدة في تبويب "العملات" → تظهر تلقائياً في dropdowns الـ BASE/QUOTE.
- [x] كل عملة نشطة → مرشحة للأسعار.
- [x] تعديل العملة → يحفظ في كل مكان دون كسر الأسعار القائمة (textual code لا يتغير).
- [x] خيار custom للـ legacy data (النصوص القديمة ما زالت تعمل).
- [x] تعطيل عملة مستخدمة في إصدار منشور = 409 (لا فقدان).
- [x] الـ FK columns nullable → لا كسر للبيانات التاريخية.

---

## 8. ما تبقى للمرحلة 4

- **ترقية FK إلى NOT NULL**: بعد ترحيل كل الـ text codes إلى currencies.
- **اعتماد المنتقي حصرياً**: إزالة خيار custom بعد التأكد من اكتمال التغطية.
- **تحويل أسعار الـ legacy إلى currencies**: مهمة backfill إضافية للـ rows التي لا تطابق أي code.
- **UI: عرض اسم العملة الكامل** في كل سطر سعر (مثلاً "SAR — Saudi Riyal" بدل `SAR`).
