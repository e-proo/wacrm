# قالب تقرير مرحلة

> يُنسخ هذا القالب لكل مرحلة تحت `docs/implementation/ai-multi-provider/`، ويستبدل النص الإرشادي بأدلة فعلية.

## 1. Metadata

| الحقل | القيمة |
|---|---|
| المرحلة | `XX — name` |
| التاريخ | ISO date |
| الفرع | branch |
| الالتزام الأساسي | commit SHA |
| الالتزام الحالي | commit SHA أو `uncommitted` |
| المنفذ/المراجع | names or agents |
| الحالة | GO / STOP / PASS / CONDITIONAL |

## 2. الهدف والنطاق

- الهدف المتفق عليه:
- ما نُفذ:
- ما لم يُنفذ عمداً:
- أي انحراف:

## 3. ملخص النتيجة

فقرة قصيرة تقود بالنتيجة، لا بسرد الخطوات.

## 4. القرارات

| القرار | السبب | ADR/مرجع | الأثر |
|---|---|---|---|

## 5. الملفات

| الملف | Added/Modified/Deleted | الغرض |
|---|---|---|

أكد أن أي ملف معدل مسبقاً من المستخدم حُفظ ولم يُكتب فوقه.

## 6. تدفق قبل/بعد

استخدم Mermaid صغيراً أو وصفاً واضحاً إن تغيرت العلاقات. لا تضف رسماً لا يوضح علاقة مهمة.

## 7. البيانات والترحيل

- migrations:
- forward behavior:
- backfill/idempotency:
- legacy compatibility:
- rollback:
- counts/verification:
- production migration run: **No** ما لم يوجد تفويض موثق.

اكتب `N/A` مع السبب إذا لم تمس المرحلة البيانات.

## 8. الأمن والخصوصية

- secrets handling:
- authorization/RLS:
- outbound/SSRF:
- redaction/logging:
- rate/time/size limits:
- findings المتبقية:

## 9. الاختبارات

| الاختبار/الملف | السيناريو | النتيجة |
|---|---|---|

### نتائج الأوامر

| الأمر الفعلي | Exit code | النتيجة/الملاحظات |
|---|---:|---|
| `...` | 0/غيره | ... |

لا تكتب `passed` لأمر لم يُشغّل. استخدم `Not run` وسبباً قابلاً للتحقق.

## 10. معايير القبول

- [ ] Criterion 1 — evidence/link
- [ ] Criterion 2 — evidence/link

## 11. المخاطر والقيود

| الخطر/القيد | الاحتمال | الأثر | التخفيف | المالك |
|---|---|---|---|---|

## 12. الرجوع

خطوات محددة لإبطال سلوك المرحلة مع المحافظة على البيانات. ميّز بين code rollback وschema rollback وfeature flag. لا تقترح drop/destructive rollback تلقائياً.

## 13. الأسئلة والمتابعة

- Blockers:
- Follow-ups خارج النطاق:
- Debt له owner/date:

## 14. توصية الانتقال

`GO` أو `STOP` مع سبب ودليل مختصر. لا تبدأ المرحلة التالية داخل التقرير.

