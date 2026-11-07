import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

vi.mock('@/lib/whatsapp/transport/openwa/session-auth', () => ({
  requireOpenWASessionAdmin: vi.fn(),
}))
vi.mock('@/lib/whatsapp/transport/openwa/credentials', () => ({
  resolveOpenWAClient: vi.fn(),
}))

import { requireOpenWASessionAdmin } from '@/lib/whatsapp/transport/openwa/session-auth'
import { resolveOpenWAClient } from '@/lib/whatsapp/transport/openwa/credentials'
import { GET } from './route'

const context = { params: Promise.resolve({ connectionId: 'connection-1' }) }
const request = () => new Request('https://wacrm.example.com/api/whatsapp/connections/openwa/connection-1/qr')

function fakeDb(connection: { session_id: string; status: string } | null) {
  const filters: Record<string, string> = {}
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((field: string, value: string) => {
      filters[field] = value
      return query
    }),
    maybeSingle: vi.fn(async () => ({
      data: filters.id === 'connection-1' && filters.account_id === 'account-1' && filters.provider === 'openwa'
        ? connection : null,
      error: null,
    })),
  }
  const db = { from: vi.fn(() => query) }
  return { db, query }
}

function arrange(connection: { session_id: string; status: string } | null, qr?: { qr: string; expiresAt?: string }) {
  const { db, query } = fakeDb(connection)
  const getSessionQr = vi.fn(async () => qr ?? { qr: 'data:image/png;base64,YWJj' })
  vi.mocked(requireOpenWASessionAdmin).mockResolvedValue({
    accountId: 'account-1', adminDb: db,
  } as never)
  vi.mocked(resolveOpenWAClient).mockResolvedValue({ client: { getSessionQr } } as never)
  return { db, query, getSessionQr }
}

describe('OW-4 QR onboarding API contract', () => {
  beforeEach(() => vi.clearAllMocks())

  it('only serves the scoped, non-cached QR with an expiry capped at 60 seconds', async () => {
    const { query, getSessionQr } = arrange(
      { session_id: 'session-1', status: 'waiting_qr' },
      { qr: 'data:image/png;base64,YWJj', expiresAt: new Date(Date.now() + 300_000).toISOString() },
    )
    const start = Date.now()
    const result = await GET(request(), context)
    expect(result.status).toBe(200)
    expect(result.headers.get('cache-control')).toContain('no-store')
    expect(result.headers.get('cache-control')).toContain('private')
    expect(result.headers.get('pragma')).toBe('no-cache')
    const body = await result.json()
    expect(body.qr).toBe('data:image/png;base64,YWJj')
    expect(Date.parse(body.expires_at)).toBeGreaterThan(start)
    expect(Date.parse(body.expires_at)).toBeLessThanOrEqual(Date.now() + 60_000)
    expect(query.eq).toHaveBeenCalledWith('id', 'connection-1')
    expect(query.eq).toHaveBeenCalledWith('account_id', 'account-1')
    expect(query.eq).toHaveBeenCalledWith('provider', 'openwa')
    expect(getSessionQr).toHaveBeenCalledWith('session-1', 'connection-1')
  })

  it('denies unauthenticated/non-admin access before any provider lookup', async () => {
    vi.mocked(requireOpenWASessionAdmin).mockRejectedValue(
      new WhatsAppTransportError('authentication_or_configuration', 'Admin access is required'),
    )
    const result = await GET(request(), context)
    expect(result.status).toBe(403)
    expect(result.headers.get('cache-control')).toContain('no-store')
    expect(resolveOpenWAClient).not.toHaveBeenCalled()
  })

  it('does not reveal an unknown or cross-tenant session', async () => {
    arrange(null)
    const result = await GET(request(), context)
    expect(result.status).toBe(404)
    expect(resolveOpenWAClient).not.toHaveBeenCalled()
  })

  it('denies QR once the session is ready', async () => {
    arrange({ session_id: 'session-1', status: 'ready' })
    const result = await GET(request(), context)
    expect(result.status).toBe(409)
    expect(resolveOpenWAClient).not.toHaveBeenCalled()
  })

  it('rejects expired QR material without persisting or returning QR bytes', async () => {
    arrange(
      { session_id: 'session-1', status: 'waiting_qr' },
      { qr: 'data:image/png;base64,YWJj', expiresAt: new Date(Date.now() - 1_000).toISOString() },
    )
    const result = await GET(request(), context)
    expect(result.status).toBe(404)
    expect(result.headers.get('cache-control')).toContain('no-store')
    expect(JSON.stringify(await result.json())).not.toContain('data:image/png')
  })
})
