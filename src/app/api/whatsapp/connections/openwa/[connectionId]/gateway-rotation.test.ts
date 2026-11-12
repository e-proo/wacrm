import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  status: vi.fn(),
  encrypt: vi.fn((key: string) => 'encrypted:' + key),
  updates: [] as Record<string, unknown>[],
  lookups: [] as Array<[string, unknown]>,
  connection: { session_id: 'gateway-session-1' } as { session_id: string } | null,
}))

vi.mock('@/lib/whatsapp/transport/openwa/session-auth', () => ({
  requireOpenWASessionAdmin: h.auth,
}))
vi.mock('@/lib/whatsapp/transport/openwa/session-lifecycle', () => ({
  logoutOpenWAConnection: vi.fn(),
  reconnectOpenWAConnection: vi.fn(),
  refreshOpenWAConnectionStatus: vi.fn(),
}))
vi.mock('@/lib/whatsapp/transport/openwa/credentials', () => ({
  resolveOpenWAClient: vi.fn(),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: h.encrypt }))
vi.mock('@/lib/whatsapp/transport/openwa/client', async (original) => {
  const actual = await original<typeof import('@/lib/whatsapp/transport/openwa/client')>()
  return {
    ...actual,
    // Use a constructible class: the runtime calls `new OpenWAClient()`.
    OpenWAClient: class {
      getSessionStatus = h.status
    },
  }
})

import { POST } from './route'

const CONNECTION = '11111111-2222-4333-8444-555555555555'
const ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const URL = 'https://pqirsnfupofhulmewakq.supabase.co'
const OLD_URL = process.env.NEXT_PUBLIC_SUPABASE_URL

function context() { return { params: Promise.resolve({ connectionId: CONNECTION }) } }
function request() {
  return new Request('https://localhost/api/whatsapp/connections/openwa/' + CONNECTION, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'update_gateway', base_url: 'https://new-quick-tunnel.trycloudflare.com',
      api_key: 'private-test-key',
    }),
  })
}

function db() {
  return {
    from: vi.fn((table: string) => {
      const filters: Record<string, unknown> = {}
      let update: Record<string, unknown> | null = null
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          h.lookups.push([key, value])
          filters[key] = value
          return query
        },
        is: () => query,
        update: (value: Record<string, unknown>) => {
          update = value
          return query
        },
        maybeSingle: async () => {
          if (table === 'whatsapp_connections') {
            return { data: filters.account_id === ACCOUNT && filters.id === CONNECTION
              ? h.connection : null, error: null }
          }
          if (table === 'whatsapp_connection_credentials' && update) {
            h.updates.push(update)
            return { data: { connection_id: CONNECTION }, error: null }
          }
          return { data: null, error: null }
        },
      }
      return query
    }),
  }
}

describe('OpenWA TEST tunnel URL rotation for an existing session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.updates.length = 0
    h.lookups.length = 0
    h.connection = { session_id: 'gateway-session-1' }
    h.status.mockResolvedValue({ sessionId: 'gateway-session-1', status: 'ready' })
    h.auth.mockResolvedValue({ accountId: ACCOUNT, adminDb: db(), user: { id: 'actor-1' } })
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL
  })
  afterEach(() => {
    if (OLD_URL === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = OLD_URL
  })

  it('rejects any attempt to update a gateway outside TEST', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://production.supabase.co'
    const response = await POST(request(), context())
    expect(response.status).toBe(409)
    expect(h.status).not.toHaveBeenCalled()
    expect(h.updates).toHaveLength(0)
  })
  it('requires authenticated admin and does not verify or save a gateway on denial', async () => {
    h.auth.mockRejectedValue(new WhatsAppTransportError('authentication_or_configuration', 'not admin'))
    expect((await POST(request(), context())).status).toBe(403)
    expect(h.status).not.toHaveBeenCalled()
    expect(h.updates).toHaveLength(0)
  })
  it('refuses to rotate an absent or cross-tenant connection', async () => {
    h.auth.mockResolvedValue({ accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      adminDb: db(), user: { id: 'actor-1' } })
    expect((await POST(request(), context())).status).toBe(409)
    expect(h.status).not.toHaveBeenCalled()
    expect(h.updates).toHaveLength(0)
  })
  it('refuses to save credentials if the new endpoint does not confirm the exact session', async () => {
    h.status.mockResolvedValue({ sessionId: 'wrong-session', status: 'ready' })
    const response = await POST(request(), context())
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(409)
    expect(h.updates).toHaveLength(0)
  })
  it('updates only scoped encrypted credentials on verified existing session without creating one', async () => {
    const response = await POST(request(), context())
    const data = await response.json()
    expect(response.status, JSON.stringify(data)).toBe(200)
    expect(data).toMatchObject({ updated: true, sessionId: 'gateway-session-1' })
    expect(h.status).toHaveBeenCalledWith('gateway-session-1', CONNECTION)
    expect(h.updates).toEqual([expect.objectContaining({
      base_url: 'https://new-quick-tunnel.trycloudflare.com',
      api_key_encrypted: 'encrypted:private-test-key',
    })])
    expect(h.lookups).toContainEqual(['account_id', ACCOUNT])
    expect(JSON.stringify(data)).not.toContain('private-test-key')
    expect(h.updates[0]).not.toHaveProperty('webhook_secret_encrypted')
  })
})
