type CoverageLegGuardResult =
  | { ok: true }
  | { ok: false; code: 'COVERAGE_LEG_WORDING_CONFLICT'; message: string }

export interface CoverageLegRegionAliases {
  pay?: string[]
  receive?: string[]
}

const GUARDED_TOOLS = new Set([
  'coverage.get_rates',
  'coverage.find_offers',
  'coverage.propose_offer',
  'coverage.propose_request',
])

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

function attributes(args: Record<string, unknown>): Record<string, unknown> | null {
  const value = args.attributes
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function rawSideArg(
  args: Record<string, unknown>,
  side: 'pay' | 'receive',
  field: 'region' | 'region_id' | 'method',
): unknown {
  const key = `${side}_${field}`
  if (Object.prototype.hasOwnProperty.call(args, key)) return args[key]
  return attributes(args)?.[key]
}

function stringSideArg(
  args: Record<string, unknown>,
  side: 'pay' | 'receive',
  field: 'region' | 'region_id' | 'method',
): string | null {
  const value = rawSideArg(args, side, field)
  return typeof value === 'string' && value.trim() ? normalize(value) : null
}

function methodSignals(method: string | null): string[] {
  if (!method) return []
  return (METHOD_TERMS[method] ?? [method]).map(normalize).filter(Boolean)
}

interface LegSignals {
  regions: string[]
  methods: string[]
}

function signalsFor(
  args: Record<string, unknown>,
  side: 'pay' | 'receive',
  aliases: CoverageLegRegionAliases,
): LegSignals {
  const region = stringSideArg(args, side, 'region')
  const aliasValues = (aliases[side] ?? []).map(normalize).filter(Boolean)
  return {
    regions: [...new Set([region, ...aliasValues].filter((value): value is string => Boolean(value)))],
    methods: methodSignals(stringSideArg(args, side, 'method')),
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
      const hardEnd = Math.min(text.length, afterMarker + 160)
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
  if (signals.regions.some((region) => segment.includes(region))) score += 2
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
    if (oppositeScore >= 2 && oppositeScore > expectedScore) return true
  }
  return false
}

export function isCoverageLegGuardedTool(toolKey: string): boolean {
  return GUARDED_TOOLS.has(toolKey)
}

export function coverageRegionIdsFromArgs(args: Record<string, unknown>): {
  payRegionId: string | null
  receiveRegionId: string | null
} {
  return {
    payRegionId: stringSideArg(args, 'pay', 'region_id'),
    receiveRegionId: stringSideArg(args, 'receive', 'region_id'),
  }
}

/**
 * Fail closed only when the latest customer wording gives explicit, high-
 * confidence evidence that the model swapped the coverage pay/receive legs.
 * Region aliases are server-resolved names/codes for model-supplied UUIDs.
 */
export function guardCoverageLegWording(
  toolKey: string,
  args: Record<string, unknown>,
  latestCustomerText: string,
  aliases: CoverageLegRegionAliases = {},
): CoverageLegGuardResult {
  if (!GUARDED_TOOLS.has(toolKey) || !latestCustomerText.trim()) return { ok: true }

  const pay = signalsFor(args, 'pay', aliases)
  const receive = signalsFor(args, 'receive', aliases)
  if (pay.regions.length === 0 && receive.regions.length === 0) return { ok: true }

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
        'The customer explicitly described the payment/hand-over leg using wording such as سأسلم/أدفع/أسدد, but the supplied pay/receive fields appear reversed. Treat the place/method attached to that wording as CUSTOMER PAY. Correct the legs or ask one concise clarification before quoting or proposing.',
    }
  }

  if (contradiction(receiveSegments, receive, pay)) {
    return {
      ok: false,
      code: 'COVERAGE_LEG_WORDING_CONFLICT',
      message:
        'The customer explicitly described the receive leg using wording such as أستلم/استلام, but the supplied pay/receive fields appear reversed. Treat the place/method attached to that wording as CUSTOMER RECEIVE. Correct the legs or ask one concise clarification before quoting or proposing.',
    }
  }

  return { ok: true }
}
