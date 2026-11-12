import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveWhatsAppTransport } from './router'
import { resolveMetaTransport } from './meta-adapter'
import { resolveOpenWATransport } from './openwa/adapter'
import { supabaseAdmin } from '@/lib/flows/admin-client'

vi.mock('./meta-adapter', () => ({ resolveMetaTransport: vi.fn() }))
vi.mock('./openwa/adapter', () => ({ resolveOpenWATransport: vi.fn() }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: vi.fn() }))

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
  beforeEach(() => vi.clearAllMocks())

  it('uses service-role only AFTER caller-scoped authorization, including guardrails', async () => {
    const serviceDb = {
      rpc: vi.fn().mockResolvedValueOnce({ data: { allowed: true, wait_ms: 0 }, error: null })
        .mockResolvedValue({ data: null, error: null }),
    } as unknown as SupabaseClient
    vi.mocked(supabaseAdmin).mockReturnValue(serviceDb)
    const send = vi.fn(async () => ({ provider: 'openwa' as const, connectionId: 'ow-1', providerMessageId: 'msg-1' }))
    vi.mocked(resolveOpenWATransport).mockResolvedValue({ connectionId: 'ow-1', transport: { provider: 'openwa', send } })
    const result = await resolveWhatsAppTransport(dbForConnection({ id: 'ow-1', account_id: 'acct-1', provider: 'openwa' }), 'acct-1', 'ow-1')
    expect(supabaseAdmin).toHaveBeenCalledTimes(1)
    expect(resolveOpenWATransport).toHaveBeenCalledWith(serviceDb, 'acct-1', 'ow-1')
    expect(result.connectionId).toBe('ow-1')
    await result.transport.send({ accountId: 'acct-1', connectionId: 'ow-1', recipient: '967700000001', content: { kind: 'text', text: 'hello' }, idempotencyKey: 'idem-1' })
    expect(serviceDb.rpc).toHaveBeenCalledWith('reserve_openwa_guardrail_send', expect.anything())
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('rejects an archived same-account OpenWA session before opening provider credentials', async () => {
    await expect(resolveWhatsAppTransport(dbForConnection({
      id: 'ow-old', account_id: 'acct-1', provider: 'openwa',
      archived_at: '2026-11-12T00:00:00.000Z',
    }), 'acct-1', 'ow-old')).rejects.toMatchObject({ code: 'connection_restricted' })
    expect(supabaseAdmin).not.toHaveBeenCalled()
    expect(resolveOpenWATransport).not.toHaveBeenCalled()
  })

  it('rejects cross-account connection BEFORE opening privileged credentials', async () => {
    await expect(resolveWhatsAppTransport(dbForConnection({ id: 'ow-1', account_id: 'acct-other', provider: 'openwa' }), 'acct-1', 'ow-1')).rejects.toMatchObject({ code: 'authentication_or_configuration' })
    expect(supabaseAdmin).not.toHaveBeenCalled()
    expect(resolveOpenWATransport).not.toHaveBeenCalled()
  })

  it('keeps Meta as default when no WACRM connection is selected', async () => {
    const resolved = { connectionId: 'meta-1', transport: { provider: 'meta_cloud', send: vi.fn() } as never }
    vi.mocked(resolveMetaTransport).mockResolvedValue(resolved)
    expect(await resolveWhatsAppTransport(dbForConnection(null), 'acct-1')).toBe(resolved)
  })
})

afterEach(() => vi.unstubAllEnvs())

describe('OW-13 pilot gate does not change Meta routing', () => {
  it('keeps both default and explicitly requested Meta sends outside OpenWA pilot admission', async () => {
    vi.clearAllMocks()
    vi.stubEnv('OPENWA_PILOT_MODE', 'enforce')
    const send = vi.fn(async () => ({ provider: 'meta_cloud' as const, connectionId: 'meta-1', providerMessageId: 'meta-mock' }))
    const resolved = { connectionId: 'meta-1', transport: { provider: 'meta_cloud' as const, send } }
    vi.mocked(resolveMetaTransport).mockResolvedValue(resolved)
    const db = dbForConnection({ id: 'meta-1', account_id: 'acct-1', provider: 'meta_cloud' })
    const defaultRoute = await resolveWhatsAppTransport(db, 'acct-1')
    const explicitRoute = await resolveWhatsAppTransport(db, 'acct-1', 'meta-1')
    await explicitRoute.transport.send({ accountId: 'acct-1', connectionId: 'meta-1', recipient: '12345678901', content: { kind: 'text', text: 'mock' } })
    expect(defaultRoute).toBe(resolved)
    expect(explicitRoute).toBe(resolved)
    expect(send).toHaveBeenCalledTimes(1)
    expect(supabaseAdmin).not.toHaveBeenCalled()
    expect(resolveOpenWATransport).not.toHaveBeenCalled()
  })
})
