import type { SupabaseClient } from '@supabase/supabase-js'
import { coverageMethodLabel } from '@/lib/messaging/domains'
import { normalizeCoverageAttributes, type CoverageAttributes } from './attributes'

export interface SupplierCoverageRoute {
  /** The requester pays in this region: the supplier receives here. */
  requesterPayRegionId: string
  requesterPayRegion: string
  requesterPayMethod: string
  /** The requester receives here: the supplier supplies/pays here. */
  requesterReceiveRegionId: string
  requesterReceiveRegion: string
  requesterReceiveMethod: string
  scope: 'domestic' | 'international'
  country: string | null
}

export interface SupplierRegionReference {
  id: string
  name: string
}

/**
 * Resolve the canonical request's two legs under tenant scope, not supplier
 * prose, model output, or an unscoped name lookup. The supplier legs are
 * strictly opposite the requester legs. Missing names/IDs must block outreach
 * rather than advertising amount-only or guessed locations.
 */
export async function loadSupplierCoverageRoute(
  db: SupabaseClient, accountId: string,
  raw: Record<string, unknown> | CoverageAttributes | null,
): Promise<SupplierCoverageRoute> {
  const normalized = normalizeCoverageAttributes(raw as Record<string, unknown> | null)
  if (!normalized.ok) throw new Error('COVERAGE_SUPPLIER_ROUTE_INVALID')
  const a = normalized.normalized
  if (!a.pay_region_id || !a.receive_region_id ||
      a.pay_region_id === a.receive_region_id) {
    throw new Error('COVERAGE_SUPPLIER_ROUTE_INCOMPLETE')
  }
  const { data, error } = await db.from('coverage_regions')
    .select('id,name').eq('account_id', accountId)
    .in('id', [a.pay_region_id, a.receive_region_id]).limit(3)
  if (error) throw error
  if (!data || data.length !== 2) throw new Error('COVERAGE_SUPPLIER_ROUTE_REGION_UNRESOLVED')
  const pay = data.find(x => x.id === a.pay_region_id)
  const receive = data.find(x => x.id === a.receive_region_id)
  const valid = (name: unknown): name is string =>
    typeof name === 'string' && name.trim().length >= 2 &&
    name.trim().length <= 80 && !/[\r\n<>]/.test(name)
  if (!valid(pay?.name) || !valid(receive?.name)) {
    throw new Error('COVERAGE_SUPPLIER_ROUTE_LABEL_INVALID')
  }
  return {
    requesterPayRegionId: a.pay_region_id,
    requesterPayRegion: pay.name.trim(),
    requesterPayMethod: coverageMethodLabel(a.pay_method),
    requesterReceiveRegionId: a.receive_region_id,
    requesterReceiveRegion: receive.name.trim(),
    requesterReceiveMethod: coverageMethodLabel(a.receive_method),
    scope: a.coverage_scope,
    country: a.coverage_country,
  }
}

export function validSupplierCoverageRoute(value: unknown): value is SupplierCoverageRoute {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Partial<SupplierCoverageRoute>
  const label = (x: unknown) => typeof x === 'string' &&
    x.trim().length >= 2 && x.trim().length <= 80 && !/[\r\n<>]/.test(x)
  const uuid = (x: unknown) => typeof x === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)
  return uuid(v.requesterPayRegionId) && uuid(v.requesterReceiveRegionId) &&
    v.requesterPayRegionId !== v.requesterReceiveRegionId &&
    label(v.requesterPayRegion) && label(v.requesterReceiveRegion) &&
    label(v.requesterPayMethod) && label(v.requesterReceiveMethod) &&
    (v.scope === 'domestic' || v.scope === 'international') &&
    (v.country == null || label(v.country))
}

export function assertSupplierRouteMatchesAttributes(
  route: SupplierCoverageRoute,
  raw: Record<string, unknown> | CoverageAttributes | null,
): void {
  const result = normalizeCoverageAttributes(raw as Record<string, unknown> | null)
  if (!result.ok || !validSupplierCoverageRoute(route)) {
    throw new Error('COVERAGE_SUPPLIER_ROUTE_SNAPSHOT_INVALID')
  }
  const a = result.normalized
  if (route.requesterPayRegionId !== a.pay_region_id ||
      route.requesterReceiveRegionId !== a.receive_region_id ||
      route.requesterPayMethod !== coverageMethodLabel(a.pay_method) ||
      route.requesterReceiveMethod !== coverageMethodLabel(a.receive_method) ||
      route.scope !== a.coverage_scope || route.country !== a.coverage_country) {
    throw new Error('COVERAGE_SUPPLIER_ROUTE_SNAPSHOT_CONFLICT')
  }
}

export function describeSupplierCoverageRoute(route: SupplierCoverageRoute): string {
  const scope = route.scope === 'international'
    ? `نطاق التغطية: دولي${route.country ? ' — ' + route.country : ''}`
    : 'نطاق التغطية: داخل اليمن'
  return [
    scope,
    `طالب التغطية يدفع في: ${route.requesterPayRegion} — ${route.requesterPayMethod}`,
    `طالب التغطية يستلم في: ${route.requesterReceiveRegion} — ${route.requesterReceiveMethod}`,
    `المطلوب منك كمورد: تسلّم التغطية في ${route.requesterReceiveRegion} (${route.requesterReceiveMethod})، وتستلم المقابل في ${route.requesterPayRegion} (${route.requesterPayMethod}).`,
  ].join('\n')
}

export function normalizeArabicPlaceText(value: string): string {
  return value.normalize('NFKC').replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g,'ي').replace(/ة/g,'ه')
    .replace(/ـ/g,'').trim().toLocaleLowerCase('ar')
}

function placeMentioned(text: string, name: string): boolean {
  const source = normalizeArabicPlaceText(text)
  const target = normalizeArabicPlaceText(name)
  if (target.length < 2) return false
  // Respect Arabic word boundaries; a 2-letter region such as إب must not
  // match a name like إبراهيم.
  const letter = /[\p{L}\p{N}]/u
  let index = source.indexOf(target)
  while (index >= 0) {
    const before = index === 0 ? '' : source[index - 1]
    const after = source[index + target.length] ?? ''
    if ((!before || !letter.test(before)) && (!after || !letter.test(after))) return true
    index = source.indexOf(target,index + target.length)
  }
  return false
}

/** Explicit contradictory governorate in the supplier's logistics notes.
 * Free text still cannot establish a new route or override a request.
 * Unknown locations in phrases like "أستلم في ..." require human review too.
 */
export function supplierNotesConflictWithRoute(
  notes: string, route: SupplierCoverageRoute,
  knownRegions: readonly SupplierRegionReference[],
): boolean {
  const allowed = new Set([route.requesterPayRegionId,route.requesterReceiveRegionId])
  if (knownRegions.some(x => !allowed.has(x.id) && placeMentioned(notes,x.name))) return true
  const n = normalizeArabicPlaceText(notes)
  // Both region names being valid is insufficient. The SUPPLIER's deliver
  // leg must equal the requester's receive leg, and the SUPPLIER's payment
  // receipt must equal the requester's pay leg. Reversed statements must be
  // reviewed as alternative terms, not silently marked compatible.
  const locationStatements = [
    {
      pattern: /(?:اسلم|ساسلم|التسليم|ادفع|الدفع|اسدد|سلم)\s+(?:المبلغ\s+)?(?:في|بمنطقه|بمدينه)\s+([\p{L}]{2,30})/gu,
      expected: route.requesterReceiveRegionId,
    },
    {
      pattern: /(?:استلم|الاستلام|اتسلم|اقبض)\s+(?:المبلغ\s+)?(?:في|بمنطقه|بمدينه)\s+([\p{L}]{2,30})/gu,
      expected: route.requesterPayRegionId,
    },
  ]
  for (const { pattern, expected } of locationStatements) {
    for (const match of n.matchAll(pattern)) {
      const place = match[1]
      const known = knownRegions.find(x => placeMentioned(place,x.name))?.id
      // Unknown cities remain for human review. Never guess city-to-region.
      if (!known || known !== expected) return true
    }
  }
  return false
}
