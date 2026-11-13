import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { preflightAgentTaskConnection } from './outbound-connection'

const db = {} as SupabaseClient
const binding = {
  accountId: 'account-a',
  connectionId: 'connection-a',
  provider: 'openwa' as const,
}

describe('Agent Task frozen WhatsApp transport preflight', () => {
  it('accepts the exact tenant-scoped ready OpenWA connection', async () => {
    const lookup = vi.fn(async () => ({
      connectionId: 'connection-a',
      provider: 'openwa' as const,
    }))
    expect(await preflightAgentTaskConnection(db, binding, lookup)).toBe(true)
    expect(lookup).toHaveBeenCalledWith(db, 'account-a', 'connection-a')
  })

  it('supports an explicitly selected Meta connection without guessing a default', async () => {
    const lookup = vi.fn(async () => ({
      connectionId: 'meta-connection',
      provider: 'meta_cloud' as const,
    }))
    expect(await preflightAgentTaskConnection(db, {
      accountId: 'account-a', connectionId: 'meta-connection', provider: 'meta_cloud',
    }, lookup)).toBe(true)
  })

  it('rejects a switched session, provider mismatch and missing connection ID', async () => {
    const switched = vi.fn(async () => ({
      connectionId: 'connection-b',
      provider: 'openwa' as const,
    }))
    expect(await preflightAgentTaskConnection(db, binding, switched)).toBe(false)

    const wrongProvider = vi.fn(async () => ({
      connectionId: 'connection-a',
      provider: 'meta_cloud' as const,
    }))
    expect(await preflightAgentTaskConnection(db, binding, wrongProvider)).toBe(false)

    const unused = vi.fn(async () => ({
      connectionId: 'connection-a',
      provider: 'openwa' as const,
    }))
    expect(await preflightAgentTaskConnection(db, { ...binding, connectionId: '' }, unused)).toBe(false)
    expect(unused).not.toHaveBeenCalled()
  })

  it('fails closed before transport ownership for offline, archived, wrong-tenant or credential errors', async () => {
    for (const error of [
      new Error('offline'), new Error('archived'),
      new Error('wrong tenant'), new Error('credentials unavailable'),
    ]) {
      const lookup = vi.fn(async (): Promise<{connectionId:string;provider:'openwa'}> => {
        throw error
      })
      expect(await preflightAgentTaskConnection(db, binding, lookup)).toBe(false)
      expect(lookup).toHaveBeenCalledTimes(1)
    }
  })
})
