// Server-only by convention.
import { createClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/ai/admin-client'

// ============================================================
// Lightweight currency lookup for UI dropdowns.
//
// We expose an anonymous Supabase client so the read can happen
// during SSR (the route handler resolves with full HTML, no
// round-trip from the client). The query is scoped via the
// session cookie — RLS enforces the account boundary as usual.
// ============================================================

export interface ActiveCurrency {
  id: string
  code: string
  display_name: string
  symbol: string | null
  decimal_digits: number
  kind: 'iso_4217' | 'historical' | 'local'
}

export async function listActiveCurrencies(accountId: string): Promise<ActiveCurrency[]> {
  const { data, error } = await supabaseAdmin()
    .from('currencies')
    .select('id, code, display_name, symbol, decimal_digits, kind')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .order('code', { ascending: true })
  if (error) throw error
  return (data ?? []) as unknown as ActiveCurrency[]
}

/**
 * Variant that uses an SSR-scoped client so the user is
 * subject to RLS without needing the admin service role.
 * Useful when the page already loaded with the user's session.
 */
export async function listActiveCurrenciesForUser(
  accessToken: string,
): Promise<ActiveCurrency[]> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    {
      global: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  )
  const { data, error } = await supabase
    .from('currencies')
    .select('id, code, display_name, symbol, decimal_digits, kind')
    .eq('status', 'active')
    .order('code', { ascending: true })
  if (error) throw error
  return (data ?? []) as ActiveCurrency[]
}
