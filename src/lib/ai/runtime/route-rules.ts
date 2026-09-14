// ============================================================
// Route-rule validation — shared by /api/ai-routes and any
// future importer. The runtime (router.ts) matches a closed
// conditions schema; the authoring side must reject anything
// outside it so a typo never silently disables a rule.
// ============================================================

export const ROUTE_KINDS = ['admin', 'rule', 'default'] as const

export const ROUTE_CHANNELS = ['whatsapp'] as const

export interface RouteConditions {
  inbox_id?: string
  tags?: string[]
  language?: string
  business_hours?: {
    start: string
    end: string
    tz: string
    weekdays: number[]
  }
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Validates a raw conditions object. Returns a list of human
 * readable errors; empty list = valid + normalized conditions.
 */
export function validateRouteConditions(
  raw: unknown,
): { ok: boolean; errors: string[]; conditions: RouteConditions } {
  const errors: string[] = []
  if (raw !== undefined && raw !== null && typeof raw !== 'object') {
    return { ok: false, errors: ['conditions must be an object'], conditions: {} }
  }
  const v = (raw ?? {}) as Record<string, unknown>

  const knownKeys = ['inbox_id', 'tags', 'language', 'business_hours']
  for (const key of Object.keys(v)) {
    if (!knownKeys.includes(key)) {
      errors.push(`unknown condition key: ${key}`)
    }
  }

  const conditions: RouteConditions = {}

  if (v.inbox_id !== undefined && v.inbox_id !== null) {
    if (typeof v.inbox_id === 'string' && /^[0-9a-f-]{20,36}$/i.test(v.inbox_id)) {
      conditions.inbox_id = v.inbox_id
    } else {
      errors.push('inbox_id must be a uuid string')
    }
  }

  if (v.tags !== undefined && v.tags !== null) {
    if (
      Array.isArray(v.tags) &&
      v.tags.every((t) => typeof t === 'string' && t.trim().length > 0 && t.length <= 60)
    ) {
      conditions.tags = v.tags.map((t) => String(t).trim())
    } else {
      errors.push('tags must be a non-empty-strings array')
    }
  }

  if (v.language !== undefined && v.language !== null) {
    if (typeof v.language === 'string' && /^[a-zA-Z-]{2,12}$/.test(v.language)) {
      conditions.language = v.language.toLowerCase()
    } else {
      errors.push('language must be a short code like "ar" or "ar-YE"')
    }
  }

  if (v.business_hours !== undefined && v.business_hours !== null) {
    const bh = v.business_hours as Record<string, unknown>
    if (
      typeof bh?.start !== 'string' ||
      !TIME_RE.test(bh.start) ||
      typeof bh?.end !== 'string' ||
      !TIME_RE.test(bh.end) ||
      typeof bh?.tz !== 'string' ||
      !bh.tz.trim() ||
      !Array.isArray(bh?.weekdays) ||
      bh.weekdays.length === 0 ||
      !bh.weekdays.every((w) => Number.isInteger(w) && (w as number) >= 0 && (w as number) <= 6)
    ) {
      errors.push(
        'business_hours needs start/end HH:MM, tz (IANA name) and weekdays 0-6 list',
      )
    } else {
      conditions.business_hours = {
        start: bh.start,
        end: bh.end,
        tz: bh.tz.trim(),
        weekdays: [...new Set(bh.weekdays as number[])].sort(),
      }
    }
  }

  return { ok: errors.length === 0, errors, conditions }
}
