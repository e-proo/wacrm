// ============================================================
// Coverage attributes — the structured fields every coverage
// offer/request carries in its `attributes` JSONB (migration 059
// indexes it with a GIN).
//
// Business context: Yemeni coverage splits into a NORTH zone
// (old-rial markets) and a SOUTH zone (new-rial markets). Every
// record therefore has TWO legs:
//
//   receive leg — where the covered money is DELIVERED
//                 (offer: where the liquidity sits; request:
//                 where the requester wants the money)
//   pay leg     — where the counter-payment HAPPENS
//
// Each leg carries a region (from the coverage_regions registry,
// macro: north / south / international) and a method. The SOUTH
// currently prices cash and networks the same, but the fields are
// separate from day one so the desk can split them later.
//
// 'any' means "whatever is available" — the wildcard that matches
// every concrete method in the suggestion engine.
//
// Keys are stable strings shared with the AI tools and the UI.
// Validation is deny-by-default: unknown keys are rejected so a
// typo'd field never silently disappears.
// ============================================================

export const COVERAGE_METHODS = [
  'cash',
  'networks',
  'bank_deposit',
  'any',
] as const

export type CoverageMethod = (typeof COVERAGE_METHODS)[number]

export const COVERAGE_SCOPES = ['domestic', 'international'] as const

export type CoverageScope = (typeof COVERAGE_SCOPES)[number]

export interface CoverageAttributes {
  /** 'domestic' (north↔south) | 'international'. Default 'domestic'. */
  coverage_scope: CoverageScope
  /** Free-text destination country; only meaningful when scope = international. */
  coverage_country: string | null
  /** Region id (coverage_regions) of the RECEIVE leg. */
  receive_region_id: string | null
  /** Method of the RECEIVE leg. */
  receive_method: CoverageMethod
  /** Region id (coverage_regions) of the PAY leg. */
  pay_region_id: string | null
  /** Method of the PAY leg. */
  pay_method: CoverageMethod
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ALLOWED_KEYS: ReadonlyArray<keyof CoverageAttributes> = [
  'coverage_scope',
  'coverage_country',
  'receive_region_id',
  'receive_method',
  'pay_region_id',
  'pay_method',
]

export type CoverageAttributesError = {
  field: string
  code: 'UNKNOWN_KEY' | 'INVALID_TYPE' | 'NOT_IN_ENUM' | 'INVALID_FORMAT'
  message: string
}

export type CoverageAttributesResult =
  | { ok: true; normalized: CoverageAttributes }
  | { ok: false; errors: CoverageAttributesError[] }

/**
 * Validate + normalize a raw attributes blob for a coverage
 * offer/request. Missing optional fields fall back to defaults:
 * scope 'domestic', methods 'any', regions null.
 */
export function normalizeCoverageAttributes(
  input: Record<string, unknown> | null | undefined,
): CoverageAttributesResult {
  const errors: CoverageAttributesError[] = []
  const v = input ?? {}

  for (const key of Object.keys(v)) {
    if (!ALLOWED_KEYS.includes(key as keyof CoverageAttributes)) {
      errors.push({
        field: key,
        code: 'UNKNOWN_KEY',
        message: `Unknown coverage attribute: ${key}`,
      })
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  // scope
  let scope: CoverageScope = 'domestic'
  if (v.coverage_scope !== undefined && v.coverage_scope !== null) {
    if (
      typeof v.coverage_scope === 'string' &&
      (COVERAGE_SCOPES as readonly string[]).includes(v.coverage_scope)
    ) {
      scope = v.coverage_scope as CoverageScope
    } else {
      errors.push({
        field: 'coverage_scope',
        code: 'NOT_IN_ENUM',
        message: 'coverage_scope must be one of: domestic, international',
      })
    }
  }

  // country
  let country: string | null = null
  if (v.coverage_country !== undefined && v.coverage_country !== null) {
    if (typeof v.coverage_country === 'string' && v.coverage_country.trim()) {
      country = v.coverage_country.trim().slice(0, 100)
    } else {
      errors.push({
        field: 'coverage_country',
        code: 'INVALID_TYPE',
        message: 'coverage_country must be a non-empty string',
      })
    }
  }

  // regions
  function parseRegion(key: 'receive_region_id' | 'pay_region_id'): string | null {
    const raw = v[key]
    if (raw === undefined || raw === null || raw === '') return null
    if (typeof raw === 'string' && UUID_RE.test(raw)) return raw
    errors.push({
      field: key,
      code: 'INVALID_FORMAT',
      message: `${key} must be a region id (uuid)`,
    })
    return null
  }
  const receiveRegion = parseRegion('receive_region_id')
  const payRegion = parseRegion('pay_region_id')

  // methods
  function parseMethod(key: 'receive_method' | 'pay_method'): CoverageMethod {
    const raw = v[key]
    if (raw === undefined || raw === null || raw === '') return 'any'
    if (
      typeof raw === 'string' &&
      (COVERAGE_METHODS as readonly string[]).includes(raw)
    ) {
      return raw as CoverageMethod
    }
    errors.push({
      field: key,
      code: 'NOT_IN_ENUM',
      message: `${key} must be one of: ${COVERAGE_METHODS.join(', ')}`,
    })
    return 'any'
  }
  const receiveMethod = parseMethod('receive_method')
  const payMethod = parseMethod('pay_method')

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    normalized: {
      coverage_scope: scope,
      coverage_country: country,
      receive_region_id: receiveRegion,
      receive_method: receiveMethod,
      pay_region_id: payRegion,
      pay_method: payMethod,
    },
  }
}

/**
 * Defensive reader for rows already in the DB (legacy rows predate
 * the schema — never throw on read).
 */
export function readCoverageAttributes(
  attrs: Record<string, unknown> | null | undefined,
): CoverageAttributes {
  const result = normalizeCoverageAttributes(attrs)
  if (result.ok) return result.normalized
  return {
    coverage_scope: 'domestic',
    coverage_country: null,
    receive_region_id: null,
    receive_method: 'any',
    pay_region_id: null,
    pay_method: 'any',
  }
}
