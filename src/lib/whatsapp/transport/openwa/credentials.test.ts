import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((value: string) => `plain:${value}`),
}))

import { resolveOpenWACredentials } from './credentials'

type QueryChain = {
  select: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  maybeSingle: ReturnType<typeof vi.fn>
}

function query(result: { data: unknown; error: unknown }): QueryChain {
  const chain = {} as QueryChain
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(async () => result)
  return chain
}

function asSupabaseClient(from: (table: string) => QueryChain): SupabaseClient {
  return { from: vi.fn(from) } as unknown as SupabaseClient
}

describe('resolveOpenWACredentials', () => {
  beforeEach(() => vi.clearAllMocks())

  it('scopes both connection and credential lookups to account and connection', async () => {
    const connectionQuery = query({ data: { id: 'conn-1', account_id: 'acc-1', provider: 'openwa' }, error: null })
    const credentialQuery = query({
      data: {
        connection_id: 'conn-1', account_id: 'acc-1', provider: 'openwa',
        base_url: 'https://openwa.example.com', api_key_encrypted: 'enc-api', webhook_secret_encrypted: 'enc-hook',
      },
      error: null,
    })
    const db = asSupabaseClient((table) => table === 'whatsapp_connections' ? connectionQuery : credentialQuery)

    await expect(resolveOpenWACredentials(db, 'acc-1', 'conn-1')).resolves.toEqual({
      accountId: 'acc-1', connectionId: 'conn-1', baseUrl: 'https://openwa.example.com',
      apiKey: 'plain:enc-api', webhookSecret: 'plain:enc-hook',
    })
    expect(connectionQuery.eq).toHaveBeenCalledWith('id', 'conn-1')
    expect(connectionQuery.eq).toHaveBeenCalledWith('account_id', 'acc-1')
    expect(connectionQuery.eq).toHaveBeenCalledWith('provider', 'openwa')
    expect(credentialQuery.eq).toHaveBeenCalledWith('connection_id', 'conn-1')
    expect(credentialQuery.eq).toHaveBeenCalledWith('account_id', 'acc-1')
  })

  it('fails closed when the connection is outside the requested account', async () => {
    const db = asSupabaseClient(() => query({ data: null, error: null }))
    await expect(resolveOpenWACredentials(db, 'acc-a', 'conn-b')).rejects.toMatchObject({ code: 'authentication_or_configuration' })
  })

  it('fails closed on a credential scope mismatch', async () => {
    const connectionQuery = query({ data: { id: 'conn-1', account_id: 'acc-1', provider: 'openwa' }, error: null })
    const credentialQuery = query({
      data: { connection_id: 'conn-1', account_id: 'acc-other', provider: 'openwa', base_url: 'https://openwa.example.com', api_key_encrypted: 'enc' },
      error: null,
    })
    const db = asSupabaseClient((table) => table === 'whatsapp_connections' ? connectionQuery : credentialQuery)
    await expect(resolveOpenWACredentials(db, 'acc-1', 'conn-1')).rejects.toMatchObject({ code: 'authentication_or_configuration' })
  })
})
