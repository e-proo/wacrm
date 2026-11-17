import { supplierNotesConflictWithRoute, type SupplierCoverageRoute,
  type SupplierRegionReference } from './supplier-request-route'

const money = /(?:^|\s)([0-9]{1,12}(?:\.[0-9]{1,4})?)(?:\s*(?:ريال|ر\.س|SAR|﷼))?(?=\s|$|[،,.!])/gi

export function normalizeQuoteArabic(text: string): string {
  return text.normalize('NFKC')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x6f0))
    .replace(/٫/g,'.').replace(/٬/g,'')
    .replace(/[\u064B-\u065F\u0670]/g,'').replace(/ـ/g,'')
    .replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه')
    .trim().toLowerCase()
}

const price = (raw: string, max: number, zero = false): string | null => {
  if (!/^\d{1,12}(?:\.\d{1,4})?$/.test(raw)) return null
  const n = Number(raw)
  return Number.isFinite(n) && n <= max && (zero ? n >= 0 : n > 0) ? raw : null
}

export function extractSupplierQuote(
  raw: string,
  facts: { remainingAmount: string; route: SupplierCoverageRoute;
    knownRegions: readonly SupplierRegionReference[] },
): {
  amount: string | null
  commission: string | null
  routeDifference: boolean
  routeAssent: boolean
  available: boolean
  finalConsent: boolean
  details: string | null
} {
  const text = normalizeQuoteArabic(raw)
  if (text.length > 800) return {
    amount:null,commission:null,routeDifference:false,routeAssent:false,
    available:false,finalConsent:false,details:null,
  }
  // A supplier may quote price and per-thousand commission in either order.
  // Remove the rate's number before considering monetary amount, preventing
  // "7 لكل 1000" from being mistaken for an offer of 7.
  const rateExpressions = [
    /(?:عمول(?:ه|تي)?|الاجر|اجر|رسوم)\s*(?:المطلوب(?:ه)?|الخاص(?:ه)?|اللي\s+اريد(?:ها)?)?\s*[:=]?\s*(\d{1,12}(?:\.\d{1,4})?)\s*(?:لكل\s*(?:1000|الف)|\/\s*1000)?/i,
    /(\d{1,12}(?:\.\d{1,4})?)\s*(?:لكل\s*(?:1000|الف)|\/\s*1000)/i,
  ]
  let commission: string | null = null
  let noRate = text
  for (const pattern of rateExpressions) {
    const hit = pattern.exec(noRate)
    if (!hit) continue
    commission = price(hit[1], 1000, true)
    noRate = noRate.slice(0, hit.index) + ' '.repeat(hit[0].length) +
      noRate.slice(hit.index + hit[0].length)
    break
  }
  let amount: string | null = null
  if (/(?:المبلغ|الطلب|القيمه)\s*(?:بال)?كامل|كامل\s+(?:المبلغ|الطلب)\b/.test(text) ||
      /(?:اوفر|اغطي|اغطيه|توفير|عندي)\s+(?:المبلغ\s+)?كامل(?:ه)?/.test(text)) {
    amount = price(facts.remainingAmount, Number(facts.remainingAmount))
  }
  const amountPattern = /(?:مبلغ|المبلغ|قيمه|القيمه|اغطي|تغطيه|توفير|اوفر|كامل|متاح|متوفر|عندي)\D{0,35}(\d{1,12}(?:\.\d{1,4})?)/i
  const explicit = amountPattern.exec(noRate)
  if (explicit) amount = price(explicit[1],Number(facts.remainingAmount))
  if (!amount) {
    // A single remaining quantity after removing the per-1000 rate is a
    // deterministic offer; multiple candidate numbers need clarification.
    const values = [...noRate.matchAll(money)].map(x=>x[1])
      .filter(x=>x !== '1000')
    const candidates = [...new Set(values)]
    if (candidates.length === 1) amount = price(candidates[0],Number(facts.remainingAmount))
  }
  const routeDifference = /(?:المسار\s*(?:مختلف|غير\s*مطابق)|غير\s*مطابق|ما\s*(?:يناسبني|يناسبنا)\s*المسار)/.test(text) ||
    supplierNotesConflictWithRoute(raw, facts.route, facts.knownRegions)
  const routeAssent = !routeDifference && (
    /(?:المسار\s*(?:مطابق|صحيح)|(?:اوافق|موافق)\s+على\s+المسار)/.test(text) ||
    /^(?:نعم|اجل|ايوه|ايوا|تمام|موافق|متوفر|متاح|استطيع|يمكنني)(?=\s|$|[،,.!])/.test(text)
  )
  const available = /^(?:نعم|اجل|ايوه|ايوا|تمام|موافق|متوفر|متاح|استطيع|يمكنني)(?=\s|$|[،,.!])/.test(text)
    || /(?:استطيع\s+توفير|اقدر\s+اوفر|يمكنني\s+توفير|اوفر\s+المبلغ)/.test(text)
  const finalConsent = /(?:^|\s)(?:اكد|اعتمد|ارفع|قدم)\s+(?:(?:على|علي)\s+)?(?:العرض|الطلب)|(?:^|\s)(?:تاكيد|اؤكد|اوافق\s+(?:على|علي)\s+التفاصيل)(?:\s|$)/.test(text)
  const details = raw.trim().length >= 10 && raw.trim().length <= 800 ?
    raw.trim() : null
  return {amount,commission,routeDifference,routeAssent,available,finalConsent,details}
}
