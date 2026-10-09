const CURRENCY_CODE = /\b(?:SAR|YER|USD|EUR|GBP|AED|KWD|OMR|QAR|BHD)\b/i

const ARABIC_CURRENCY =
  /(?:ريال\s*(?:سعودي|يمني|عماني|قطري)?|السعودي|سعودي|اليمني|يمني|دولار|الدولار|يورو|اليورو|درهم|الدرهم|دينار|الدينار|جنيه|الجنيه)/i

const FX_RATE_CUE =
  /(?:سعر\s*الصرف|اسعار?\s*الصرف|أسعار?\s*الصرف|صرف\s+(?:ال|س|ي|د)|كم\s+(?:سعر|صرف)|بكم\s+(?:ال|س|ي|د)|سعر\s+(?:شراء|بيع)|(?:أريد|اريد|ابغى|أبغى|احتاج|أحتاج)\s+(?:أشتري|اشتري|أبيع|ابيع|شراء|بيع)|exchange\s+rate|fx\s+rate|buy\s+rate|sell\s+rate|how\s+much\s+(?:is|for)|rate\s+(?:for|of))/i

const NON_FX_RATE_CONTEXT =
  /(?:تغطية|التغطية|عمولة|العمولة|commission|coverage|fee\s+rate|pricing\s+rule)/i

/**
 * Identifies a fresh, concrete exchange-rate question that must be grounded in
 * exchange_rates.get_current rather than conversation history or retrieved KB.
 *
 * The detector is intentionally conservative: it requires both an FX/rate cue
 * and a recognizable currency reference, while excluding coverage/commission
 * language that has a separate authoritative rate tool.
 */
export function requiresFreshFxRate(text: string): boolean {
  const value = text.trim()
  if (!value || NON_FX_RATE_CONTEXT.test(value)) return false
  const hasCurrency = CURRENCY_CODE.test(value) || ARABIC_CURRENCY.test(value)
  return hasCurrency && FX_RATE_CUE.test(value)
}
