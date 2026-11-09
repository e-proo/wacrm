import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  resolveClient: vi.fn(),
  createSession: vi.fn(),
  startSession: vi.fn(),
  insertConnection: vi.fn(),
  insertCredentials: vi.fn(),
  updates: [] as Array<Record<string, unknown>>,
  deletes: [] as Array<string>,
}))

vi.mock('@/lib/whatsapp/transport/openwa/session-auth', () => ({
  requireOpenWASessionAdmin: h.requireAdmin,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: vi.fn(() => 'encrypted-server-only') }))
vi.mock('@/lib/whatsapp/transport/openwa/credentials', () => ({
  resolveOpenWAClient: h.resolveClient,
}))

import { POST } from './route'

function dbFixture() {
  const connection = {
    insert: h.insertConnection,
    update: vi.fn((value: Record<string, unknown>) => {
      h.updates.push(value)
      return update
    }),
    delete: vi.fn(() => {
      h.deletes.push('connection')
      return update
    }),
  }
  const update: Record<string, unknown> = {
    eq: vi.fn(() => update),
    then: (resolve: (value: { error: null }) => void) => resolve({ error: null }),
  }
  const creds = { insert: h.insertCredentials }
  return {
    from: vi.fn((table: string) => table === 'whatsapp_connections' ? connection : creds),
  }
}
function request() {
  return new Request('https://localhost/api/whatsapp/connections/openwa', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base_url: 'https://gateway.example.com', api_key: 'do-not-expose', display_name: 'OpenWA TEST' }),
  })
}

describe('OpenWA session create outcome safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.updates.length = 0
    h.deletes.length = 0
    h.insertConnection.mockResolvedValue({ error: null })
    h.insertCredentials.mockResolvedValue({ error: null })
    h.requireAdmin.mockResolvedValue({ accountId: 'acct-1', adminDb: dbFixture() })
    h.resolveClient.mockResolvedValue({ client: {
      createSession: h.createSession,
      startSession: h.startSession,
    } })
    h.createSession.mockResolvedValue({ sessionId: 'gateway-session-1', status: 'created' })
    h.startSession.mockResolvedValue({ status: 'qr_ready' })
  })

  it('returns 201 and persists the remote session before start', async () => {
    const response = await POST(request())
    expect(response.status).toBe(201)
    expect(h.createSession).toHaveBeenCalledTimes(1)
    expect(h.startSession).toHaveBeenCalledWith('gateway-session-1', expect.any(String))
    expect(h.updates).toEqual([
      expect.objectContaining({ session_id: 'gateway-session-1' }),
      expect.objectContaining({ status: 'waiting_qr' }),
    ])
  })

  it('keeps uncertain gateway-create failures for reconciliation without leaking credentials', async () => {
    h.createSession.mockRejectedValue(new WhatsAppTransportError('ambiguous_outcome', 'OpenWA request timed out; outcome requires reconciliation'))
    const response = await POST(request())
    const payload = await response.json()
    expect(response.status).toBe(409)
    expect(payload).toMatchObject({ code: 'ambiguous_outcome', stage: 'gateway_create', reconciliation_required: true })
    expect(h.updates).toEqual([expect.objectContaining({
      status: 'failed', provider_metadata: {
        onboarding_stage: 'gateway_create', onboarding_failure_code: 'ambiguous_outcome',
        onboarding_reconciliation_required: true,
      },
    })])
    expect(h.deletes).toHaveLength(0)
    expect(JSON.stringify(payload)).not.toContain('do-not-expose')
    expect(h.createSession).toHaveBeenCalledTimes(1)
  })

  it('exposes only a safe gateway 400 reason and records its stage', async () => {
    h.createSession.mockRejectedValue(new WhatsAppTransportError('invalid_request', 'OpenWA request rejected (400; code=SESSION_LIMIT)'))
    const response = await POST(request())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 'invalid_request', stage: 'gateway_create', reconciliation_required: true,
    })
    expect(h.updates[0].provider_metadata).toMatchObject({
      onboarding_failure_code: 'invalid_request', onboarding_stage: 'gateway_create',
    })
    expect(h.deletes).toHaveLength(0)
  })

  it('retains a known gateway session when QR startup is rejected', async () => {
    h.startSession.mockRejectedValue(new WhatsAppTransportError('retryable_provider_failure', 'Gateway returned 502'))
    const response = await POST(request())
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      stage: 'gateway_start', code: 'retryable_provider_failure', reconciliation_required: true,
    })
    expect(h.updates[0].session_id).toBe('gateway-session-1')
    expect(h.updates[1].provider_metadata).toMatchObject({ onboarding_stage: 'gateway_start' })
    expect(h.deletes).toHaveLength(0)
  })
})
