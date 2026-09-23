import { supabaseAdmin } from '@/lib/ai/admin-client'
import { ServiceError } from '@/lib/services/domain-services'

export { ServiceError }

// ============================================================
// Currency catalog CRUD (Phase 2 completion).
//
// Reads are account-scoped via RLS; writes are admin+ gated at
// the API layer. A currency cannot be disabled while any FX V2
// pair references it because published rate history remains
// attached to that pair.
// ============================================================

export interface CurrencyRow {
  id: string
  account_id: string
  code: string
  display_name: string
  notes: string | null
  status: 'active' | 'disabled'
  kind: 'iso_4217' | 'historical' | 'local'
  decimal_digits: number
  symbol: string | null
  created_at: string
  updated_at: string
}

export interface CurrencyInput {
  code: string
  displayName: string
  notes?: string | null
  status?: 'active' | 'disabled'
  kind?: 'iso_4217' | 'historical' | 'local'
  decimalDigits?: number
  symbol?: string | null
}

export const CURRENCY_CODE_PATTERN = /^[A-Z_]{3,8}$/

export function normalizeCurrencyCode(code: string): string | null {
  const normalized = code.trim().toUpperCase()
  return CURRENCY_CODE_PATTERN.test(normalized) ? normalized : null
}
const VALID_KIND = new Set<CurrencyInput['kind']>(['iso_4217', 'historical', 'local'])

function validateInput(input: CurrencyInput): void {
  if (!input.code || !CURRENCY_CODE_PATTERN.test(input.code)) {
    throw new ServiceError(
      'INVALID_CODE',
      'code must be 3-8 uppercase letters (e.g. SAR, YER_OLD).',
    )
  }
  if (!input.displayName?.trim()) {
    throw new ServiceError('INVALID_NAME', 'displayName is required.')
  }
  if (input.kind && !VALID_KIND.has(input.kind)) {
    throw new ServiceError(
      'INVALID_KIND',
      'kind must be one of: iso_4217, historical, local.',
    )
  }
  if (
    typeof input.decimalDigits === 'number' &&
    (input.decimalDigits < 0 || input.decimalDigits > 8)
  ) {
    throw new ServiceError(
      'INVALID_DECIMAL_DIGITS',
      'decimalDigits must be between 0 and 8.',
    )
  }
}

// ------------------------------------------------------------
// Read
// ------------------------------------------------------------
export async function listCurrencies(
  accountId: string,
): Promise<CurrencyRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('currencies')
    .select(
      'id, account_id, code, display_name, notes, status, kind, decimal_digits, symbol, created_at, updated_at',
    )
    .eq('account_id', accountId)
    .order('code', { ascending: true })
  if (error) throw error
  return (data ?? []) as unknown as CurrencyRow[]
}

export async function getCurrency(
  accountId: string,
  id: string,
): Promise<CurrencyRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('currencies')
    .select(
      'id, account_id, code, display_name, notes, status, kind, decimal_digits, symbol, created_at, updated_at',
    )
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return (data as unknown as CurrencyRow | null) ?? null
}

export async function findCurrencyByCode(
  accountId: string,
  code: string,
  options: { includeDisabled?: boolean } = {},
): Promise<CurrencyRow | null> {
  const normalized = normalizeCurrencyCode(code)
  if (!normalized) return null

  let query = supabaseAdmin()
    .from('currencies')
    .select(
      'id, account_id, code, display_name, notes, status, kind, decimal_digits, symbol, created_at, updated_at',
    )
    .eq('account_id', accountId)
    .eq('code', normalized)

  if (!options.includeDisabled) query = query.eq('status', 'active')

  const { data, error } = await query.maybeSingle()
  if (error) throw error
  return (data as unknown as CurrencyRow | null) ?? null
}

export async function getCurrenciesByIds(
  accountId: string,
  ids: readonly string[],
): Promise<CurrencyRow[]> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return []

  const { data, error } = await supabaseAdmin()
    .from('currencies')
    .select(
      'id, account_id, code, display_name, notes, status, kind, decimal_digits, symbol, created_at, updated_at',
    )
    .eq('account_id', accountId)
    .in('id', unique)
  if (error) throw error
  return (data ?? []) as unknown as CurrencyRow[]
}

// ------------------------------------------------------------
// Write
// ------------------------------------------------------------
export async function createCurrency(
  accountId: string,
  input: CurrencyInput,
  actorUserId: string | null,
): Promise<CurrencyRow> {
  validateInput(input)
  const { data, error } = await supabaseAdmin()
    .from('currencies')
    .insert({
      account_id: accountId,
      code: input.code,
      display_name: input.displayName.trim(),
      notes: input.notes ?? null,
      status: input.status ?? 'active',
      kind: input.kind ?? 'iso_4217',
      decimal_digits: input.decimalDigits ?? 2,
      symbol: input.symbol ?? null,
      created_by: actorUserId,
    })
    .select(
      'id, account_id, code, display_name, notes, status, kind, decimal_digits, symbol, created_at, updated_at',
    )
    .single()
  if (error || !data) {
    const code = (error as { code?: string } | null)?.code
    if (code === '23505') {
      throw new ServiceError(
        'DUPLICATE_CODE',
        `A currency with code "${input.code}" already exists in this account.`,
        409,
      )
    }
    throw error
  }
  return data as unknown as CurrencyRow
}

export async function updateCurrency(
  accountId: string,
  id: string,
  input: Partial<CurrencyInput> & { status?: 'active' | 'disabled' },
  actorUserId: string | null,
): Promise<CurrencyRow> {
  if (input.code !== undefined && !CURRENCY_CODE_PATTERN.test(input.code)) {
    throw new ServiceError(
      'INVALID_CODE',
      'code must be 3-8 uppercase letters or underscores.',
    )
  }
  if (input.kind !== undefined && !VALID_KIND.has(input.kind)) {
    throw new ServiceError(
      'INVALID_KIND',
      'kind must be one of: iso_4217, historical, local.',
    )
  }

  // Refuse to deactivate a currency that's referenced by any
  // active rate row in any book. This is a best-effort guard —
  // the schema doesn't enforce the FK yet so we scan.
  if (input.status === 'disabled') {
    const existing = await getCurrency(accountId, id)
    if (!existing) {
      throw new ServiceError('NOT_FOUND', 'Currency not found.', 404)
    }
    const inUse = await isCurrencyInUse(accountId, existing.id)
    if (inUse) {
      throw new ServiceError(
        'CURRENCY_IN_USE',
        'Cannot disable a currency that is referenced by an FX pair.',
        409,
      )
    }
  }

  const patch: Record<string, unknown> = {}
  if (input.code !== undefined) patch.code = input.code
  if (input.displayName !== undefined)
    patch.display_name = input.displayName.trim()
  if (input.notes !== undefined) patch.notes = input.notes
  if (input.status !== undefined) patch.status = input.status
  if (input.kind !== undefined) patch.kind = input.kind
  if (input.decimalDigits !== undefined)
    patch.decimal_digits = input.decimalDigits
  if (input.symbol !== undefined) patch.symbol = input.symbol
  patch.updated_by = actorUserId

  const { data, error } = await supabaseAdmin()
    .from('currencies')
    .update(patch)
    .eq('account_id', accountId)
    .eq('id', id)
    .select(
      'id, account_id, code, display_name, notes, status, kind, decimal_digits, symbol, created_at, updated_at',
    )
    .maybeSingle()
  if (error) throw error
  if (!data) {
    throw new ServiceError('NOT_FOUND', 'Currency not found.', 404)
  }
  return data as unknown as CurrencyRow
}

/**
 * True when the currency is referenced by any FX V2 pair. Disabled pairs
 * still retain immutable rate history and therefore remain references.
 */
async function isCurrencyInUse(
  accountId: string,
  currencyId: string,
): Promise<boolean> {
  const { count, error } = await supabaseAdmin()
    .from('exchange_rate_pairs')
    .select('id', { head: true, count: 'exact' })
    .eq('account_id', accountId)
    .or(`base_currency_id.eq.${currencyId},quote_currency_id.eq.${currencyId}`)
  if (error) throw error
  return (count ?? 0) > 0
}

// ------------------------------------------------------------
// Reference: the four currencies seeded by default
// ------------------------------------------------------------
export const DEFAULT_CURRENCIES: ReadonlyArray<{
  code: string
  displayName: string
  kind: CurrencyInput['kind']
  decimalDigits: number
  symbol: string | null
  notes: string | null
}> = [
  {
    code: 'SAR',
    displayName: 'Saudi Riyal',
    kind: 'iso_4217',
    decimalDigits: 2,
    symbol: 'SAR',
    notes: null,
  },
  {
    code: 'USD',
    displayName: 'US Dollar',
    kind: 'iso_4217',
    decimalDigits: 2,
    symbol: 'US$',
    notes: null,
  },
  {
    code: 'YER',
    displayName: 'Yemeni Rial (current)',
    kind: 'iso_4217',
    decimalDigits: 2,
    symbol: 'YER',
    notes: 'Unified Yemeni Rial used since 2018.',
  },
  {
    code: 'YER_OLD',
    displayName: 'Yemeni Rial (old)',
    kind: 'historical',
    decimalDigits: 2,
    symbol: 'YER',
    notes: 'Pre-2018 Yemeni Rial still referenced in informal markets.',
  },
]
