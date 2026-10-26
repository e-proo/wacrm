import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveWhatsAppTransport } from './router'
import { resolveMetaTransport } from './meta-adapter'
import { resolveOpenWATransport } from './openwa/adapter'

vi.mock('./meta-adapter', () => ({ resolveMetaTransport: vi.fn() }))
vi.mock('./openwa/adapter', () => ({ resolveOpenWATransport: vi.fn() }))

function dbForConnection(row: Record<string, unknown> | null): SupabaseClient {
  return { from() {
    const filters: Record<string, unknown> = {}
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (key: string, value: unknown) => { filters[key] = value; return b },
      maybeSingle: async () => ({ data: row && filters.account_id === row.account_id && filters.id === row.id ? row : null, error: null }),
    }
    return b
  } } as unknown as SupabaseClient
}

describe('provider-neutral outbound router', () => {
  it('routes an account-scoped OpenWA connection without exposing engine choice', async () => {
    const transport = { provider: 'openwa', send: vi.fn() } as never
    vi.mocked(resolveOpenWATransport).mockResolvedValue({ connectionId: 'ow-1', transport })
    const result = await resolveWhatsAppTransport(dbForConnection({ id: 'ow-1', account_id: 'acct-1', provider: 'openwa' }), 'acct-1', 'ow-1')
    expect(resolveOpenWATransport).toHaveBeenCalledWith(expect.anything(), 'acct-1', 'ow-1')
    expect(result.connectionId).toBe('ow-1')
  })

  it('rejects a connection outside the account', async () => {
    await expect(resolveWhatsAppTransport(dbForConnection({ id: 'ow-1', account_id: 'acct-other', provider: 'openwa' }), 'acct-1', 'ow-1')).rejects.toMatchObject({ code: 'authentication_or_configuration' })
  })

  it('keeps Meta as default when no WACRM connection is selected', async () => {
    const resolved = { connectionId: 'meta-1', transport: { provider: 'meta_cloud', send: vi.fn() } as never }
    vi.mocked(resolveMetaTransport).mockResolvedValue(resolved)
    expect(await resolveWhatsAppTransport(dbForConnection(null), 'acct-1')).toBe(resolved)
  })
})
