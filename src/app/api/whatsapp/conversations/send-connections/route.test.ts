import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenError } from '@/lib/auth/account'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  list: vi.fn(),
  refresh: vi.fn(),
  db: {} as Record<string, unknown>,
}))

vi.mock('@/lib/auth/account', async (original) => {
  const actual = await original<typeof import('@/lib/auth/account')>()
  return { ...actual, requireRole: h.requireRole }
})
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db }))
vi.mock('@/lib/whatsapp/transport/openwa/conversation-connections', () => ({
  listConversationOpenWASendConnections: h.list,
}))
vi.mock('@/lib/whatsapp/transport/openwa/session-lifecycle', () => ({
  refreshOpenWAConnectionStatus: h.refresh,
}))

import { GET, POST } from './route'

const CONVERSATION = '11111111-2222-4333-8444-555555555555'
const CONNECTION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef'
const URL = 'https://localhost/api/whatsapp/conversations/send-connections'
function request(id = CONNECTION) {
  return new Request(URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: CONVERSATION, connection_id: id }),
  })
}

describe('conversation OpenWA status recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireRole.mockResolvedValue({ accountId: 'account-1', role: 'admin' })
    h.list.mockResolvedValue({
      current_connection_id: OTHER, options: [],
      unavailable_options: [{ id: CONNECTION, display_name: 'Session', status: 'disconnected', gateway_host: 'gateway.test' }],
    })
    h.refresh.mockResolvedValue({ status: 'ready' })
  })

  it('lets agents see a non-ready session but not refresh it', async () => {
    h.requireRole.mockResolvedValue({ accountId: 'account-1', role: 'agent' })
    const response = await GET(new Request(URL + '?conversation_id=' + CONVERSATION))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ can_refresh: false, options: [],
      unavailable_options: [expect.objectContaining({ status: 'disconnected' })] })
    expect(h.requireRole).toHaveBeenCalledWith('agent')
  })

  it('refreshes only a matching same-account and same-phone session with admin permission', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ready' })
    expect(h.requireRole).toHaveBeenCalledWith('admin')
    expect(h.list).toHaveBeenCalledWith(h.db, 'account-1', CONVERSATION)
    expect(h.refresh).toHaveBeenCalledWith(h.db, 'account-1', CONNECTION)
  })

  it('rejects other-phone or unknown session IDs before any provider request', async () => {
    const response = await POST(request(OTHER))
    expect(response.status).toBe(409)
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('refuses cross-account sessions even if the attacker supplies a UUID', async () => {
    h.list.mockResolvedValue({ current_connection_id: OTHER, options: [], unavailable_options: [] })
    const response = await POST(request())
    expect(response.status).toBe(409)
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('requires administrator role before touching the server-side DB', async () => {
    h.requireRole.mockRejectedValue(new ForbiddenError('Insufficient role'))
    const response = await POST(request())
    expect(response.status).toBe(403)
    expect(h.list).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('validates conversation and connection ids before reading any session', async () => {
    const response = await POST(new Request(URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: 'invalid', connection_id: CONNECTION }),
    }))
    expect(response.status).toBe(400)
    expect(h.list).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
  })
})
