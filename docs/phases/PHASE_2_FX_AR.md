# خدمة أسعار الصرف — دليل تفصيلي

> **تاريخ التنفيذ:** سبتمبر 2026  
> **الفرع:** `phase-2/services-coverage-rates`  
> **الـ commits:** `9679ccd` (الأساس) → `b59f828` (شريط جانبي) → `a472342` (توثيق) → **commit الـ FX الجديد** (إكمال CRUD + history + validate + UI)  
> **المرجع المعماري:** `plans/تعدد الوكلاء وقسم الخدمات/03_PHASE_2_SERVICES_COVERAGE_AND_RATES.md` §8

تحتوي خدمة أسعار الصرف على:
- **إدارة الدفاتر** بسياق (region/channel/settlement_method).
- **إصدارات غير قابلة للتعديل** (immutable) لكل دفتر، مع **نشر ذرّي** عبر RPC.
- **تحقق قبل النشر** (dry-run) عبر RPC.
- **سجل تاريخي لكل حركة سعر** (`exchange_rate_history`).
- **واجهة إدارة** كاملة مع مؤشرات stale / live / minutes-remaining.

---

## 1. قاعدة البيانات

### 1.1 الجداول (الأساس في Migration 049)

#### `exchange_rate_books`
- **`name`**: اسم وصفي ("صنعاء / واتساب / نقدي").
- **`region`, `channel`, `settlement_method`**: مفتاح السياق. قيد فريد جزئي يمنع تكرار نشط واحد فقط لكل تركيبة.
- **`timezone`**: IANA.
- **`stale_after_seconds`**: بعد كم ثانية يُعتبر السعر **stale**. افتراضياً 1800 ثانية (30 دقيقة).
- **`current_published_version_id`**: مؤشر ديناميكي للإصدار المنشور الحالي.
- **`status`**: `active` | `archived`.

#### `exchange_rate_book_versions`
- **`version_number`**: متسلسل لكل دفتر (1, 2, 3, ...).
- **`status`**: `draft` | `published` | `superseded`.
- **`effective_at`, `expires_at`**: نافذة صلاحية.
- **`source`**: `manual` | `admin_agent` | `external` (الأخيران للمرحلة 3).

#### `exchange_rates`
- **`base_currency`, `quote_currency`**: ISO-4217-like (مثل SAR, YER, USD).
- **`buy_rate`, `sell_rate`**: `numeric(20, 8)` — دقة عالية لتجنب 1-ulp drift.
- **`min_amount`, `max_amount`**: شرائح اختيارية `numeric(20, 4)`.
- **`rate_unit`**: إذا كان السوق يستخدم تمثيلاً خاصاً (مثل لكل 100).
- قيد فريد: `(version_id, base_currency, quote_currency, coalesce(min_amount, -1), coalesce(max_amount, -1))`.

### 1.2 `exchange_rate_history` (Migration 051)

سجل ملحق فقط، صف واحد لكل زوج عملات في كل نشر.

- **`from_version_id`**: الإصدار الذي أدخل هذا السعر.
- **`to_version_id`**: الإصدار الذي استبدله (NULL = السعر الحالي).
- **`buy_rate`, `sell_rate`**: snapshot وقت النشر (NULL بعد الـ supersede).
- **`effective_at`**: timestamp للنشر.
- **`event_kind`**: `created` | `superseded` | `expired`.

**أنماط الاستعلام المدعومة:**
- "السعر الحالي لزوج معين" → فهرس `(account_id, book_id, base, quote) WHERE to_version_id IS NULL AND event_kind='created'`.
- "تاريخ الزوج عبر الزمن" → فهرس `(account_id, book_id, base, quote, effective_at DESC)`.
- "كل الأحداث في نافذة زمنية" → فهرس `(account_id, created_at DESC)`.

### 1.3 RPCs

#### `publish_exchange_rate_version(book_id, version_id, actor_user_id)`
- **يتحقق**: الكتاب نشط، الإصدار `draft`.
- **يرفض**: أزواج عملات مكررة داخل الإصدار.
- **يكتب التاريخ**: يحوّل الصفوف الحالية لـ `superseded` (للأزواج الموجودة في الإصدار الجديد) ويُدخل صفوف `created` جديدة.
- **يُلغي**: الإصدار السابق (`published → superseded`).
- **يُنشر**: الإصدار المستهدف (`draft → published`).
- **يُبدّل**: مؤشر `current_published_version_id`.
- **يكتب حدث تدقيق**: `exchange_rate.version.published` مع `rate_count`.
- **كل ذلك في معاملة واحدة**.

#### `validate_exchange_rate_version(account_id, book_id, version_id)`
- **DRY-RUN** — لا طفرات.
- يُرجع:
```json
{
  "ok": boolean,
  "errors": [
    { "code": "BOOK_NOT_ACTIVE" | "VERSION_NOT_DRAFT" | "DUPLICATE_PAIRS" | "NON_POSITIVE_RATES" | "NOT_FOUND" | "CROSS_ACCOUNT",
      "message": "...",
      "pairs": [...] }
  ],
  "warnings": [ { "code": "EMPTY_VERSION", "message": "..." } ],
  "duplicate_pairs": [{ "base": "...", "quote": "..." }],
  "non_positive_rates": [{ "base": "...", "quote": "...", "side": "buy"|"sell" }],
  "pairs_with_no_buy_or_sell": [{ "base": "...", "quote": "..." }],
  "rate_count": number
}
```
- service-role فقط.

---

## 2. طبقة المجال

### 2.1 `src/lib/services/rates/staleness.ts`

`evaluateStaleness(version, now): StalenessResult`
- `is_stale: true` إذا `now > effective_at + stale_after_seconds` أو `now >= expires_at`.
- `secondsUntilStale`: المتبقي.

### 2.2 `src/lib/services/rates/crud.ts`

كل العمليات على سعر الصرف:

| الدالة | الوصف |
|---|---|
| `listBooks(accountId)` | قائمة الدفاتر. |
| `createBook(accountId, input, actor)` | إنشاء دفتر. يرفض التكرار بـ 409 `DUPLICATE_BOOK`. |
| `listVersions(accountId, bookId)` | قائمة الإصدارات (DESC). |
| `createDraftVersion(accountId, bookId, input, actor)` | يُنشئ `version_number = max + 1`. |
| `listRatesForVersion(accountId, versionId)` | أسعار إصدار معيّن. |
| `putVersionRates(accountId, bookId, versionId, rates)` | يستبدل كل أسعار إصدار `draft`. يرفض الإصدارات غير الـ draft بـ 409. |
| `validateVersion(accountId, bookId, versionId)` | استدعاء RPC التحقق. |
| `publishVersion(accountId, bookId, versionId, actor)` | نشر ذرّي. |
| `getRateHistory(query)` | سجل التاريخ مع فلاتر. |

### 2.3 `src/lib/services/domain-services.ts`

- **`getCurrentExchangeRate(input)`** — موجود مسبقاً (Migration 049).
  - يحلّ الـ book حسب السياق (region/channel/settlement).
  - يفحص staleness.
  - **يُرجع `unavailable_stale` إذا انتهى** — لا يُرجع سعر منتهي أبداً.
  - يحوّل نية العميل (`customer_sells_base` / `customer_buys_base`) إلى `buy` / `sell`.

---

## 3. مسارات API (admin+)

| المسار | الأفعال | الوصف |
|---|---|---|
| `GET /api/exchange-rate-books` | list | قائمة الدفاتر. |
| `POST /api/exchange-rate-books` | create | إنشاء دفتر بسياق. |
| `GET /api/exchange-rate-books/[id]/versions` | list | إصدارات دفتر. |
| `POST /api/exchange-rate-books/[id]/versions` | create draft | إنشاء إصدار مسودة جديد. |
| `GET /api/exchange-rate-books/[id]/versions/[vid]/rates` | list rates | أسعار إصدار. |
| `PUT /api/exchange-rate-books/[id]/versions/[vid]/rates` | replace rates | استبدال كل أسعار مسودة. |
| `POST /api/exchange-rate-books/[id]/versions/[vid]/validate` | validate | فحص جاف قبل النشر. |
| `POST /api/exchange-rate-books/[id]/publish` | publish | النشر الذرّي. |
| `GET /api/exchange-rates/current` | read | قراءة آمنة للسعر الحالي (stale-aware). |
| `GET /api/exchange-rate-history` | read | سجل تدقيق مفلتر. |

كل المسارات admin+ + rate limit `adminAction` + typed errors.

---

## 4. واجهة المستخدم

### 4.1 تبويب "أسعار الصرف" في `/services`

`ExchangeRateBooksPanel` يحتوي على:

1. **بطاقة إنشاء دفتر**: name + region + settlement + stale.
2. **بطاقات الدفاتر**: عرض النقر للاختيار، مع شارات channel/region/settlement.
3. **شارة الحالة للإصدار المنشور الحالي**:
   - أخضر "حالي" + الدقائق المتبقية حتى الـ staleness.
   - أحمر "منتهي" إذا تجاوز النافذة.
4. **بطاقة الإصدارات**: قائمة بأرقام الإصدارات وحالاتها، زر "إصدار مسودة جديد".
5. **محرر الأسعار** (للإصدارات الـ draft فقط):
   - صفوف BASE/QUOTE/buy/sell/min/max.
   - إضافة صف / حفظ / تحقق / نشر.
   - لوحة نتائج التحقق (errors + warnings).
6. **بطاقة التاريخ**: جدول sorted DESC، يعرض الزوج والأسعار ونوع الحدث (`created` / `superseded` / `expired`).

### 4.2 الترجمة

- `tabFx` في en/ar/ko.
- كل النصوص مترجمة.

---

## 5. الاختبارات

| الملف | الاختبارات | الغطاء |
|---|---|---|
| `staleness.test.ts` | 5 | كل حالات الانتهاء. |
| `crud.test.ts` | 3 | عقود نقية: decimal round-trip، ISO-4217 shape، ValidateResult envelope. |

**المجموع**: 8 اختبارات لخدمة الصرف (1226 إجمالياً في المشروع).

---

## 6. ضمانات المرحلة

- [x] **النشر الذرّي**: لا يمكن للعميل رؤية نصف عملات بالسعر الجديد.
- [x] **Stale protection**: `unavailable_stale` بدلاً من إعادة سعر منتهي.
- [x] **History**: كل نشر يُسجّل في `exchange_rate_history` مع snapshots.
- [x] **Validation**: dry-run RPC يكشف أخطاء قبل النشر.
- [x] **Immutable published versions**: لا يمكن تعديل أسعار إصدار منشور.
- [x] **UI: stale badge + minutes remaining**: مؤشرات بصرية واضحة.

---

## 7. مثال تدفق كامل

1. المستخدم يفتح `/services` → تبويب "أسعار الصرف".
2. ينشئ دفتر "صنعاء / واتساب / نقدي".
3. ينشئ "إصدار مسودة جديد" → يفتح محرر الأسعار.
4. يضيف صفوف: SAR/YER شراء 418 / بيع 420.
5. يضغط "تحقق" → النتيجة: ✅ `validationOk`.
6. يضغط "نشر" → `current_published_version_id` يُحدّث، الإصدار `published`، يُكتب `exchange_rate_history` صف جديد.
7. الدفتر يُظهر شارة "حالي" + "30 دقيقة متبقية".
8. بعد 30 دقيقة → الشارة تتحول لـ "منتهي". واجهة الـ `/api/exchange-rates/current?intent=customer_buys_base&base=SAR&quote=YER` تُرجع `unavailable_stale`.
9. الجدول "تاريخ الأسعار" يُظهر الزوج SAR/YER مع `event_kind='created'` + تاريخ النشر.
10. ينشئ مسودة جديدة بسعر 419/421 → يحفظ → يتحقق → ينشر.
11. التاريخ يُظهر صفّين: الأول `superseded`، الثاني `created`.

---

## 8. ما لم يُنفذ (متعمد للمرحلة 3)

- **استدعاء من AI**: تكامل `getCurrentExchangeRate` كأداة لوكلاء AI (سيُنفّذ في المرحلة 3 ضمن `ai/tools/registry.ts`).
- **مزامنة أسعار خارجية**: `source='external'` محفوظ في المخطط لكن لا توجد خلفيات سحب تلقائية.
- **إشعارات بحدوث staleness**: لا webhook/email عند انتهاء صلاحية السعر.
- **تصدير CSV للتاريخ**: لا endpoint لذلك.
- **Vocab مغلقة للمناطق/العملات**: حالياً نص حر مع CHECK بسيط.
