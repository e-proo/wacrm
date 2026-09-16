type CoverageLegGuardResult =
  | { ok: true }
  | { ok: false; code: 'COVERAGE_LEG_WORDING_CONFLICT'; message: string }

const GUARDED_TOOLS = new Set(['coverage.get_rates', 'coverage.find_offers'])

const PAY_MARKERS = [
  'سأسلم',
  'ساسلم',
  'سوف اسلم',
  'باسلم',
  'ادفع',
  'سأدفع',
  'سادفع',
  'سوف ادفع',
  'بسدد',
  'اسدد',
  'سأسدد',
  'ساسدد',
  'pay',
  'paying',
  'hand over',
]

const RECEIVE_MARKERS = [
  'استلم',
  'أستلم',
  'سأستلم',
  'ساستلم',
  'سوف استلم',
  'استلام',
  'receive',
  'receiving',
]

const METHOD_TERMS: Record<string, string[]> = {
  cash: ['نقد', 'نقدا', 'كاش', 'cash'],
  networks: ['شبكات', 'شبكه', 'شبكة', 'network', 'networks'],
  remittance: ['حواله', 'حوالة', 'remittance'],
  bank_deposit: ['ايداع بنكي', 'ايداع', 'bank deposit'],
  any: [],
}

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[،,;؛!?؟.\n\r]+/g, ' | ')
    .replace(/\s+/g, ' ')
    .trim()
}

const NORMALIZED_PAY_MARKERS = PAY_MARKERS.map(normalize)
const NORMALIZED_RECEIVE_MARKERS = RECEIVE_MARKERS.map(normalize)

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? normalize(value) : null
}

function methodSignals(method: string | null): string[] {
  if (!method) return []
  return (METHOD_TERMS[method] ?? [method]).map(normalize).filter(Boolean)
}

interface LegSignals {
  region: string | null
  methods: string[]
}

function signalsFor(args: Record<string, unknown>, side: 'pay' | 'receive'): LegSignals {
  const method = stringArg(args, `${side}_method`)
  return {
    region: stringArg(args, `${side}_region`),
    methods: methodSignals(method),
  }
}

function firstIndexAfter(text: string, values: string[], start: number): number | null {
  let best: number | null = null
  for (const value of values) {
    const index = text.indexOf(value, start)
    if (index >= 0 && (best === null || index < best)) best = index
  }
  return best
}

function segmentsAfterMarkers(
  text: string,
  markers: string[],
  oppositeMarkers: string[],
): string[] {
  const segments: string[] = []
  for (const marker of markers) {
    let cursor = 0
    while (cursor < text.length) {
      const index = text.indexOf(marker, cursor)
      if (index < 0) break
      const start = index
      const afterMarker = index + marker.length
      const nextOpposite = firstIndexAfter(text, oppositeMarkers, afterMarker)
      const nextBoundary = text.indexOf('|', afterMarker)
      const hardEnd = Math.min(text.length, afterMarker + 140)
      const candidates = [hardEnd]
      if (nextOpposite !== null) candidates.push(nextOpposite)
      if (nextBoundary >= 0) candidates.push(nextBoundary)
      const end = Math.min(...candidates)
      segments.push(text.slice(start, end).trim())
      cursor = afterMarker
    }
  }
  return segments
}

function scoreLeg(segment: string, signals: LegSignals): number {
  let score = 0
  if (signals.region && segment.includes(signals.region)) score += 2
  if (signals.methods.some((term) => segment.includes(term))) score += 1
  return score
}

function contradiction(
  segments: string[],
  expected: LegSignals,
  opposite: LegSignals,
): boolean {
  for (const segment of segments) {
    const expectedScore = scoreLeg(segment, expected)
    const oppositeScore = scoreLeg(segment, opposite)
    // Region evidence is intentionally weighted higher than method wording.
    // Only block on a clear winner; ambiguous language is left to the model
    // to clarify instead of turning this guard into a second NLP classifier.
    if (oppositeScore >= 2 && oppositeScore > expectedScore) return true
  }
  return false
}

/**
 * Fail closed only when the latest customer wording gives explicit, high-
 * confidence evidence that the model swapped the coverage pay/receive legs.
 *
 * Arabic examples:
 *   "سأسلم المبلغ شبكات في صنعاء" => صنعاء/شبكات is the CUSTOMER PAY leg.
 *   "سأستلم نقد في حضرموت"       => حضرموت/نقد is the CUSTOMER RECEIVE leg.
 *
 * Generic coverage wording without explicit pay/receive verbs is not blocked;
 * the system prompt/tool contract handles it and may ask a clarification.
 */
export function guardCoverageLegWording(
  toolKey: string,
  args: Record<string, unknown>,
  latestCustomerText: string,
): CoverageLegGuardResult {
  if (!GUARDED_TOOLS.has(toolKey) || !latestCustomerText.trim()) return { ok: true }

  const pay = signalsFor(args, 'pay')
  const receive = signalsFor(args, 'receive')
  if (!pay.region && !receive.region) return { ok: true }

  const text = normalize(latestCustomerText)
  const paySegments = segmentsAfterMarkers(
    text,
    NORMALIZED_PAY_MARKERS,
    NORMALIZED_RECEIVE_MARKERS,
  )
  const receiveSegments = segmentsAfterMarkers(
    text,
    NORMALIZED_RECEIVE_MARKERS,
    NORMALIZED_PAY_MARKERS,
  )

  if (contradiction(paySegments, pay, receive)) {
    return {
      ok: false,
      code: 'COVERAGE_LEG_WORDING_CONFLICT',
      message:
        'The customer explicitly described the payment/hand-over leg using wording such as سأسلم/أدفع/أسدد, but the supplied pay/receive fields appear reversed. Treat the place/method attached to that wording as CUSTOMER PAY. Correct the legs or ask one concise clarification before quoting.',
    }
  }

  if (contradiction(receiveSegments, receive, pay)) {
    return {
      ok: false,
      code: 'COVERAGE_LEG_WORDING_CONFLICT',
      message:
        'The customer explicitly described the receive leg using wording such as أستلم/استلام, but the supplied pay/receive fields appear reversed. Treat the place/method attached to that wording as CUSTOMER RECEIVE. Correct the legs or ask one concise clarification before quoting.',
    }
  }

  return { ok: true }
}
