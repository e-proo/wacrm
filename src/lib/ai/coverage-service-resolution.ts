import { supabaseAdmin } from './admin-client'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ResolvedCoverageService {
  id: string
  code: string
  canonicalized: boolean
  source: 'id' | 'code' | 'coverage_fallback'
}

/**
 * Resolve model/change-request coverage service identifiers to the canonical
 * account-scoped service UUID. Coverage tools are domain-specific, so when a
 * model supplies a stale/hallucinated identifier we may fall back only to the
 * account's active canonical `coverage` service. We never accept arbitrary
 * cross-account ids and never persist unresolved model text as a UUID.
 */
export async function resolveCanonicalCoverageService(
  accountId: string,
  rawIdentifier: unknown,
): Promise<ResolvedCoverageService | null> {
  const raw = typeof rawIdentifier === 'string' ? rawIdentifier.trim() : ''
  const db = supabaseAdmin()

  if (raw) {
    let query = db
      .from('services')
      .select('id, code')
      .eq('account_id', accountId)
      .eq('status', 'active')

    query = UUID_RE.test(raw) ? query.eq('id', raw) : query.eq('code', raw)
    const { data, error } = await query.maybeSingle()
    if (error) throw error
    if (data) {
      return {
        id: data.id,
        code: data.code,
        canonicalized: data.id !== raw,
        source: UUID_RE.test(raw) ? 'id' : 'code',
      }
    }
  }

  const { data: fallback, error: fallbackError } = await db
    .from('services')
    .select('id, code')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .eq('code', 'coverage')
    .maybeSingle()
  if (fallbackError) throw fallbackError
  if (!fallback) return null

  return {
    id: fallback.id,
    code: fallback.code,
    canonicalized: fallback.id !== raw,
    source: 'coverage_fallback',
  }
}
