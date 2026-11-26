import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  markProcessed: vi.fn(),
  normalizeInbound: vi.fn(),
  processInbound: vi.fn(),
  preflight: vi.fn(),
  defer: vi.fn(),
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
  classifyOpenWAWebhookRejection: vi.fn((error: unknown) => {
    const message = error instanceof Error ? error.message : ''
    if (message === 'Invalid OpenWA webhook signature') return 'invalid_signature'
    if (message === 'Unknown OpenWA session') return 'unknown_session'
    if (message === 'Invalid OpenWA webhook JSON') return 'invalid_json'
    if (message === 'OpenWA webhook receipt could not be reserved') return 'receipt_reservation_failed'
    return 'unexpected_error'
  }),
}))
vi.mock('@/lib/whatsapp/inbound-normalization', () => ({
  normalizeOpenWAInboundMessage: h.normalizeInbound,
  normalizeOpenWAOwnSentMessage: vi.fn(() => null),
}))
vi.mock('@/lib/whatsapp/inbound-processor', () => ({ processNormalizedInboundMessage: h.processInbound }))
vi.mock('@/lib/whatsapp/transport/openwa/deferred', () => ({
  preflightOpenWAInboundIdentity: h.preflight, deferOpenWAWebhook: h.defer,
}))
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
  vi.stubEnv('WACRM_OPENWA_DURABLE_INTAKE','off')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-only-fixture')
  h.verify.mockResolvedValue(claim)
  h.markProcessed.mockResolvedValue(undefined)
  h.parseStatus.mockReturnValue(null)
  h.applyStatus.mockResolvedValue('updated')
  h.normalizeInbound.mockReturnValue({
    message: { id: 'm-1', provider: 'openwa', connectionId: 'connection-1', providerMessageId: 'm-1', type: 'text', from: '12345678901', timestamp: '1792950000', text: { body: 'hi' } },
    contact: { wa_id: '12345678901', profile: { name: 'Contact' } },
  })
  h.preflight.mockResolvedValue('ready')
  h.defer.mockResolvedValue(undefined)
  h.processInbound.mockResolvedValue(undefined)
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data: { owner_user_id: 'owner-1' }, error: null })) }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  h.db.from.mockReturnValue(query)
})

describe('OW14-W05: signed webhook intake rejection contract', () => {
  it.each([
    ['Invalid OpenWA webhook signature', 401, 'invalid_signature', null],
    ['Unknown OpenWA session', 404, 'unknown_session', null],
    ['Invalid OpenWA webhook JSON', 400, 'invalid_json', null],
    ['OpenWA webhook receipt could not be reserved', 503, 'intake_unavailable', '5'],
    ['secret=PRIVATE_TOKEN provider=db exception', 503, 'intake_unavailable', '5'],
  ])('returns bounded non-PII status for %s', async (reason, expectedStatus, expectedCode, retryAfter) => {
    h.verify.mockRejectedValueOnce(new Error(reason))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const res = await POST(request())
      expect(res.status).toBe(expectedStatus)
      expect(res.headers.get('Retry-After')).toBe(retryAfter)
      expect(res.headers.get('Cache-Control')).toContain('no-store')
      const body = await res.json()
      expect(body).toEqual({
        error: 'OpenWA webhook intake rejected',
        code: expectedCode,
      })
      expect(JSON.stringify(body)).not.toContain('PRIVATE_TOKEN')
      expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_TOKEN')
      expect(h.processInbound).not.toHaveBeenCalled()
      expect(h.markProcessed).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
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
  it('hydrates a previously unknown native sender before entering the unified inbound processor', async () => {
    const native = '123456789012345@lid'
    h.normalizeInbound.mockReturnValue({
      message: { id: 'm-lid', provider: 'openwa', connectionId: 'connection-1', providerMessageId: 'm-lid', type: 'text', from: native, providerChatId: native, timestamp: '1792950000', text: { body: 'hello' } },
      contact: { wa_id: native, profile: { name: 'New sender' } },
    })
    h.preflight.mockImplementation(async (_db: unknown, input: { inbound: { message: { from: string }; contact: { wa_id: string } } }) => {
      input.inbound.message.from = '967700000001'
      input.inbound.contact.wa_id = '967700000001'
      return 'ready'
    })
    const res = await POST(request())
    expect(res.status).toBe(202)
    expect(h.preflight).toHaveBeenCalledWith(h.db, expect.objectContaining({
      accountId: 'account-1', connectionId: 'connection-1', sessionId: 'session-1',
    }))
    expect(h.processInbound).toHaveBeenCalledWith(
      expect.objectContaining({ from: '967700000001', providerChatId: native }),
      expect.objectContaining({ wa_id: '967700000001' }),
      'account-1', 'connection-1', 'owner-1', '', true, undefined,
    )
  })
  it('does not acknowledge a transient on-demand identity lookup failure as processed', async () => {
    h.preflight.mockRejectedValueOnce(new Error('provider temporarily unavailable'))
    const res = await POST(request())
    expect(res.status).toBe(503)
    expect(h.processInbound).not.toHaveBeenCalled()
    expect(h.markProcessed).toHaveBeenCalledWith(
      h.db, 'account-1', 'connection-1', 'evt-1', 'lease-1', 'processing_failed',
    )
  })

  it('persists an unresolved native LID and acknowledges only after the durable SQL claim commits', async () => {
    h.preflight.mockResolvedValueOnce('unresolved')
    const native = '123456789012345@lid'
    h.normalizeInbound.mockReturnValue({
      message: { id: 'm-native', provider: 'openwa', connectionId: 'connection-1', providerMessageId: 'm-native', type: 'text', from: native, providerChatId: native, timestamp: '1792950000', text: { body: 'new customer' } },
      contact: { wa_id: native, profile: { name: 'Unknown sender' } },
    })
    const res = await POST(request())
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, deferred: 'pending_identity' })
    expect(h.defer).toHaveBeenCalledWith(h.db, expect.objectContaining({
      accountId: 'account-1', connectionId: 'connection-1', sessionId: 'session-1',
      providerEventId: 'evt-1', providerMessageId: 'm-native', processingToken: 'lease-1',
      deferred: expect.objectContaining({ kind: 'unresolved_identity' }),
    }))
    expect(h.processInbound).not.toHaveBeenCalled()
    expect(h.markProcessed).not.toHaveBeenCalled()
  })

  it('durably defers unmatched native ACK without a second WhatsApp send', async () => {
    h.verify.mockResolvedValue({ ...claim, envelope: { ...envelope, event: 'message.ack' } })
    h.parseStatus.mockReturnValue({ providerMessageId: 'true_123@lid_MSG', status: 'delivered' })
    h.applyStatus.mockResolvedValue('unknown')
    const res = await POST(request())
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, deferred: 'pending_receipt' })
    expect(h.defer).toHaveBeenCalledWith(h.db, expect.objectContaining({
      providerMessageId: 'true_123@lid_MSG',
      deferred: expect.objectContaining({ kind: 'unmatched_status' }),
    }))
    expect(h.processInbound).not.toHaveBeenCalled()
    expect(h.markProcessed).not.toHaveBeenCalled()
  })

  it('returns 503 and keeps the signed lease recoverable if durable storage fails', async () => {
    h.preflight.mockResolvedValue('unresolved')
    h.defer.mockRejectedValueOnce(new Error('database unavailable'))
    const res = await POST(request())
    expect(res.status).toBe(503)
    expect(h.markProcessed).toHaveBeenCalledWith(
      h.db, 'account-1', 'connection-1', 'evt-1', 'lease-1', 'processing_failed',
    )
    expect(h.processInbound).not.toHaveBeenCalled()
  })

})

describe('FIX-04 durable acknowledgment boundary',()=>{
 it('returns 202 only for committed queue reservation and does not execute business logic',async()=>{
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://pqirsnfupofhulmewakq.supabase.co')
  vi.stubEnv('WACRM_OPENWA_DURABLE_INTAKE','test_only')
  h.verify.mockResolvedValue({...claim,queued:true,queueDuplicate:false,processingToken:undefined})
  const response=await POST(request())
  expect(response.status).toBe(202)
  expect(await response.json()).toEqual({ok:true,queued:true,duplicate:false})
  expect(h.verify).toHaveBeenCalledWith(h.db,expect.objectContaining({durableMode:expect.any(Boolean)}))
  expect(h.processInbound).not.toHaveBeenCalled()
  expect(h.markProcessed).not.toHaveBeenCalled()
 })
 it('acknowledges exact durable duplicate without rerunning business logic',async()=>{
  h.verify.mockResolvedValue({...claim,queued:true,queueDuplicate:true,processingToken:undefined})
  const response=await POST(request())
  expect(response.status).toBe(202);expect(await response.json()).toEqual({ok:true,queued:true,duplicate:true})
  expect(h.processInbound).not.toHaveBeenCalled()
 })
})
