import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  markProcessed: vi.fn(),
  normalizeInbound: vi.fn(),
  processInbound: vi.fn(),
  processEcho: vi.fn(),
  refreshSession: vi.fn(),
  parseStatus: vi.fn(),
  applyStatus: vi.fn(),
  db: { from: vi.fn(), storage: {} },
}))

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => h.db) }))
vi.mock('@/lib/whatsapp/transport/openwa/webhook', () => ({
  verifyAndReserveOpenWAWebhook: h.verify,
  markOpenWAWebhookProcessed: h.markProcessed,
  classifyOpenWAWebhookRejection: vi.fn(() => 'unexpected_error'),
}))
vi.mock('@/lib/whatsapp/inbound-normalization', () => ({
  normalizeOpenWAInboundMessage: h.normalizeInbound,
  normalizeOpenWAOwnSentMessage: vi.fn(() => null),
}))
vi.mock('@/lib/whatsapp/inbound-processor', () => ({ processNormalizedInboundMessage: h.processInbound }))
vi.mock('@/lib/whatsapp/transport/openwa/outbound-echo', () => ({ processOpenWAOwnSentEcho: h.processEcho }))
vi.mock('@/lib/whatsapp/transport/openwa/webhook-media', () => ({ extractOpenWASignedInlineMedia: vi.fn(() => undefined) }))
vi.mock('@/lib/whatsapp/status-lifecycle', () => ({
  applyOpenWAStatusWithRetry: h.applyStatus, parseOpenWAStatusEvent: h.parseStatus,
}))
vi.mock('@/lib/whatsapp/transport/openwa/session-lifecycle', () => ({
  refreshOpenWAConnectionStatus: h.refreshSession,
}))

import { POST } from './route'

const envelope = {
  eventId: 'evt-1', sessionId: 'session-1',
  timestamp: '2026-11-09T13:00:00.000Z', event: 'message.received',
}
const claim = {
  accountId: 'account-1', connectionId: 'connection-1', envelope,
  duplicate: false, processingToken: 'lease-1',
}
function request() {
  return new Request('https://localhost/api/whatsapp/openwa/webhook', {
    method: 'POST', headers: { 'x-openwa-signature': 'fixture-signature' },
    body: JSON.stringify({ event: envelope.event }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://database.example')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only-fixture')
  h.verify.mockResolvedValue(claim)
  h.markProcessed.mockResolvedValue(undefined)
  h.parseStatus.mockReturnValue(null)
  h.applyStatus.mockResolvedValue('updated')
  h.normalizeInbound.mockReturnValue({
    message: { id: 'm-1', provider: 'openwa', connectionId: 'connection-1', providerMessageId: 'm-1', type: 'text', from: '12345678901', timestamp: '1792950000', text: { body: 'hi' } },
    contact: { wa_id: '12345678901', profile: { name: 'Contact' } },
  })
  h.processInbound.mockResolvedValue(undefined)
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data: { owner_user_id: 'owner-1' }, error: null })) }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  h.db.from.mockReturnValue(query)
})

describe('OpenWA webhook completion acknowledgement', () => {
  it('acknowledges a previously completed duplicate without replaying business logic', async () => {
    h.verify.mockResolvedValue({ ...claim, duplicate: true, processingToken: undefined })
    const res = await POST(request())
    expect(res.status).toBe(200)
    expect(h.processInbound).not.toHaveBeenCalled()
    expect(h.markProcessed).not.toHaveBeenCalled()
  })

  it('does not acknowledge in-flight incomplete delivery as completed', async () => {
    h.verify.mockResolvedValue({ ...claim, inFlight: true, processingToken: undefined })
    const res = await POST(request())
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('5')
    expect(h.processInbound).not.toHaveBeenCalled()
  })

  it('waits for business logic and lease finalization before returning 202', async () => {
    let finish: (() => void) | undefined
    h.processInbound.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const pending = POST(request())
    await vi.waitFor(() => { expect(h.processInbound).toHaveBeenCalledTimes(1) })
    expect(h.markProcessed).not.toHaveBeenCalled()
    finish?.()
    const res = await pending
    expect(res.status).toBe(202)
    expect(h.markProcessed).toHaveBeenCalledWith(expect.anything(), 'account-1', 'connection-1', 'evt-1', 'lease-1')
  })

  it('preserves failed processing for a signed gateway retry, never sending a new WhatsApp message', async () => {
    h.processInbound.mockRejectedValue(new Error('private provider response token=do-not-log'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const res = await POST(request())
      expect(res.status).toBe(503)
      expect(res.headers.get('Retry-After')).toBe('5')
      expect(h.markProcessed).toHaveBeenCalledWith(
        expect.anything(), 'account-1', 'connection-1', 'evt-1', 'lease-1', 'processing_failed',
      )
      expect(JSON.stringify(warn.mock.calls)).not.toContain('do-not-log')
    } finally {
      warn.mockRestore()
    }
  })
})
