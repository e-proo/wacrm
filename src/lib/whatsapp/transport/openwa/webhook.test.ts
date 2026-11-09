import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveOpenWACredentials } from './credentials'
import { classifyOpenWAWebhookRejection, parseOpenWAWebhookEnvelope, verifyAndReserveOpenWAWebhook, markOpenWAWebhookProcessed } from './webhook'

vi.mock('./credentials', () => ({ resolveOpenWACredentials: vi.fn() }))

const mockedResolveCredentials = vi.mocked(resolveOpenWACredentials)
const rawBody = JSON.stringify({ idempotencyKey: 'evt-1', deliveryId: 'attempt-1', timestamp: '2026-10-26T18:00:00.000Z', sessionId: 'session-1', instanceId: 'instance-1', event: 'message', data: { text: 'hello' } })
const timestamp = '2026-10-26T18:00:00.000Z'
const nowMs = Date.parse(timestamp)
const webhookSecret = 'webhook-secret'

function signature() {
  return createHmac('sha256', webhookSecret).update(rawBody, 'utf8').digest('hex')
}

function dbFixture(options: { connection?: unknown; connectionError?: unknown; insertError?: unknown; receipt?: unknown; claimed?: unknown } = {}) {
  const connection = Object.prototype.hasOwnProperty.call(options, 'connection') ? options.connection : {
    id: 'connection-1',
    account_id: 'account-1',
    provider: 'openwa',
    session_id: 'session-1',
    instance_id: 'instance-1',
    status: 'connected',
  }

  const connectionQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: connection, error: options.connectionError ?? null }),
  }
  connectionQuery.select.mockReturnValue(connectionQuery)
  connectionQuery.eq.mockReturnValue(connectionQuery)

  let reclaiming = false
  const receiptQuery = {
    insert: vi.fn().mockResolvedValue({ error: options.insertError ?? null }),
    select: vi.fn(), eq: vi.fn(), is: vi.fn(), update: vi.fn(),
    maybeSingle: vi.fn(async () => ({
      data: reclaiming ? (options.claimed === undefined ? { id: 'receipt-1' } : options.claimed)
        : (options.receipt === undefined ? {
          processed_at: '2026-10-26T17:59:00Z', received_at: '2026-10-26T17:58:00Z',
          processing_token: null, processing_started_at: null, processing_attempts: 1,
        } : options.receipt),
      error: null,
    })),
  }
  receiptQuery.select.mockReturnValue(receiptQuery)
  receiptQuery.eq.mockReturnValue(receiptQuery)
  receiptQuery.is.mockReturnValue(receiptQuery)
  receiptQuery.update.mockImplementation(() => { reclaiming = true; return receiptQuery })

  const db = {
    from: vi.fn((table: string) => table === 'whatsapp_connections' ? connectionQuery : receiptQuery),
  }

  return { db, connectionQuery, receiptQuery }
}

describe('OpenWA webhook intake', () => {
  beforeEach(() => {
    mockedResolveCredentials.mockReset()
    mockedResolveCredentials.mockResolvedValue({
      accountId: 'account-1',
      connectionId: 'connection-1',
      baseUrl: 'https://openwa.example.com',
      apiKey: 'api-key',
      webhookSecret,
    })
  })

  it('parses the frozen envelope and rejects malformed payloads', () => {
    expect(parseOpenWAWebhookEnvelope(rawBody)).toMatchObject({
      eventId: 'evt-1', sessionId: 'session-1', instanceId: 'instance-1', event: 'message',
    })
    expect(() => parseOpenWAWebhookEnvelope('{')).toThrow('Invalid OpenWA webhook JSON')
    expect(() => parseOpenWAWebhookEnvelope('{}')).toThrow('requires idempotencyKey, timestamp, sessionId, and event')
  })

  it('resolves session identity first, verifies signature, and reserves the event', async () => {
    const { db, connectionQuery, receiptQuery } = dbFixture()
    const result = await verifyAndReserveOpenWAWebhook(db as never, {
      rawBody, signature: signature(), nowMs,
    })

    expect(connectionQuery.eq).toHaveBeenCalledWith('provider', 'openwa')
    expect(connectionQuery.eq).toHaveBeenCalledWith('session_id', 'session-1')
    expect(connectionQuery.eq).not.toHaveBeenCalledWith('instance_id', 'instance-1')
    expect(mockedResolveCredentials).toHaveBeenCalledWith(db, 'account-1', 'connection-1')
    expect(receiptQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      account_id: 'account-1', connection_id: 'connection-1', provider: 'openwa', provider_event_id: 'evt-1',
    }))
    expect(result.duplicate).toBe(false)
  })

  it('pins an older unbound session instance only after signed verification', async () => {
    const { db, connectionQuery, receiptQuery } = dbFixture({ connection: {
      id: 'connection-1', account_id: 'account-1', provider: 'openwa',
      session_id: 'session-1', instance_id: null, status: 'connected',
    } })
    const pinQuery = {
      update: vi.fn(), eq: vi.fn(), is: vi.fn(), select: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'connection-1' }, error: null }),
    }
    pinQuery.update.mockReturnValue(pinQuery)
    pinQuery.eq.mockReturnValue(pinQuery)
    pinQuery.is.mockReturnValue(pinQuery)
    pinQuery.select.mockReturnValue(pinQuery)
    let connectionLookups = 0
    db.from.mockImplementation((table: string) => table !== 'whatsapp_connections'
      ? receiptQuery
      : (++connectionLookups === 1 ? connectionQuery : pinQuery))
    const reserved = await verifyAndReserveOpenWAWebhook(db as never, { rawBody, signature: signature(), nowMs })
    expect(reserved.connectionId).toBe('connection-1')
    expect(pinQuery.update).toHaveBeenCalledWith({ instance_id: 'instance-1' })
    expect(pinQuery.eq).toHaveBeenCalledWith('account_id', 'account-1')
    expect(pinQuery.eq).toHaveBeenCalledWith('provider', 'openwa')
    expect(pinQuery.is).toHaveBeenCalledWith('instance_id', null)
  })

  it('never binds an unverified instance or accepts a conflicting stored instance', async () => {
    const legacy = dbFixture({ connection: {
      id: 'connection-1', account_id: 'account-1', provider: 'openwa',
      session_id: 'session-1', instance_id: null, status: 'connected',
    } })
    await expect(verifyAndReserveOpenWAWebhook(legacy.db as never, {
      rawBody, signature: '0'.repeat(64), nowMs,
    })).rejects.toThrow('Invalid OpenWA webhook signature')
    expect(legacy.db.from).toHaveBeenCalledTimes(1)
    mockedResolveCredentials.mockClear()
    const conflict = dbFixture({ connection: {
      id: 'connection-1', account_id: 'account-1', provider: 'openwa',
      session_id: 'session-1', instance_id: 'other-instance', status: 'connected',
    } })
    await expect(verifyAndReserveOpenWAWebhook(conflict.db as never, {
      rawBody, signature: signature(), nowMs,
    })).rejects.toThrow('Unknown OpenWA session')
    expect(mockedResolveCredentials).not.toHaveBeenCalled()
  })

  it('rejects a concurrent legacy session binding to a different instance', async () => {
    const { db, connectionQuery, receiptQuery } = dbFixture({ connection: {
      id: 'connection-1', account_id: 'account-1', provider: 'openwa',
      session_id: 'session-1', instance_id: null, status: 'connected',
    } })
    const pin = {
      update: vi.fn(), eq: vi.fn(), is: vi.fn(), select: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }
    pin.update.mockReturnValue(pin); pin.eq.mockReturnValue(pin)
    pin.is.mockReturnValue(pin); pin.select.mockReturnValue(pin)
    const reread = {
      select: vi.fn(), eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { instance_id: 'other-instance' }, error: null }),
    }
    reread.select.mockReturnValue(reread); reread.eq.mockReturnValue(reread)
    let lookups = 0
    db.from.mockImplementation((table: string) => {
      if (table !== 'whatsapp_connections') return receiptQuery
      return [connectionQuery, pin, reread][lookups++]
    })
    await expect(verifyAndReserveOpenWAWebhook(db as never, {
      rawBody, signature: signature(), nowMs,
    })).rejects.toThrow('Unknown OpenWA session')
    expect(receiptQuery.insert).not.toHaveBeenCalled()
  })

  it('accepts a correctly signed legacy event that omits optional instanceId', async () => {
    const withoutInstance = JSON.stringify({
      idempotencyKey: 'evt-no-instance', timestamp, sessionId: 'session-1',
      event: 'message.received', data: { text: 'hello' },
    })
    const signatureWithoutInstance = createHmac('sha256', webhookSecret)
      .update(withoutInstance, 'utf8').digest('hex')
    const { db, receiptQuery } = dbFixture()
    const result = await verifyAndReserveOpenWAWebhook(db as never, {
      rawBody: withoutInstance, signature: signatureWithoutInstance, nowMs,
    })
    expect(result.envelope.instanceId).toBeUndefined()
    expect(receiptQuery.insert).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown sessions before accepting an event', async () => {
    const { db } = dbFixture({ connection: null })
    await expect(verifyAndReserveOpenWAWebhook(db as never, {
      rawBody, signature: signature(), nowMs,
    })).rejects.toThrow('Unknown OpenWA session')
    expect(mockedResolveCredentials).not.toHaveBeenCalled()
  })

  it('rejects inactive sessions before credential lookup or reservation', async () => {
    const { db, receiptQuery } = dbFixture({
      connection: {
        id: 'connection-1',
        account_id: 'account-1',
        provider: 'openwa',
        session_id: 'session-1',
        instance_id: 'instance-1',
        status: 'disconnected',
      },
    })

    await expect(verifyAndReserveOpenWAWebhook(db as never, {
      rawBody, signature: signature(), nowMs,
    })).rejects.toThrow('OpenWA session is not active')
    expect(mockedResolveCredentials).not.toHaveBeenCalled()
    expect(receiptQuery.insert).not.toHaveBeenCalled()
  })

  it('rejects missing webhook credentials and invalid signatures', async () => {
    const { db } = dbFixture()
    mockedResolveCredentials.mockResolvedValueOnce({
      accountId: 'account-1', connectionId: 'connection-1', baseUrl: 'https://openwa.example.com', apiKey: 'api-key',
    })
    await expect(verifyAndReserveOpenWAWebhook(db as never, {
      rawBody, signature: signature(), nowMs,
    })).rejects.toThrow('webhook secret is not configured')

    mockedResolveCredentials.mockResolvedValueOnce({
      accountId: 'account-1', connectionId: 'connection-1', baseUrl: 'https://openwa.example.com', apiKey: 'api-key', webhookSecret,
    })
    await expect(verifyAndReserveOpenWAWebhook(db as never, {
      rawBody, signature: '0'.repeat(64), nowMs,
    })).rejects.toThrow('Invalid OpenWA webhook signature')
  })

  it('treats the receipt unique constraint as an idempotent duplicate', async () => {
    const { db } = dbFixture({ insertError: { code: '23505' } })
    const result = await verifyAndReserveOpenWAWebhook(db as never, {
      rawBody, signature: signature(), nowMs,
    })
    expect(result.duplicate).toBe(true)
  })

  it('does not acknowledge a concurrent incomplete receipt while its lease is active', async () => {
    const { db, receiptQuery } = dbFixture({ insertError: { code: '23505' }, receipt: {
      processed_at: null, processing_started_at: '2026-10-26T17:59:50Z',
      processing_token: 'active-worker', received_at: '2026-10-26T17:59:50Z',
      processing_attempts: 1,
    } })
    const result = await verifyAndReserveOpenWAWebhook(db as never, { rawBody, signature: signature(), nowMs })
    expect(result).toMatchObject({ duplicate: false, inFlight: true })
    expect(receiptQuery.update).not.toHaveBeenCalled()
  })

  it('retries an explicitly failed event immediately even when its arrival is recent', async () => {
    const { db } = dbFixture({ insertError: { code: '23505' }, receipt: {
      processed_at: null, processing_started_at: null,
      processing_token: 'failed-worker', processing_error: 'processing_failed',
      received_at: '2026-10-26T17:59:59Z', processing_attempts: 1,
    } })
    const result = await verifyAndReserveOpenWAWebhook(db as never, { rawBody, signature: signature(), nowMs })
    expect(result.duplicate).toBe(false)
    expect(result.inFlight).toBeUndefined()
    expect(result.processingToken).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('reclaims an expired reservation via compare-and-set and preserves scope', async () => {
    const { db, receiptQuery } = dbFixture({ insertError: { code: '23505' }, receipt: {
      processed_at: null, processing_started_at: '2026-10-26T17:55:00Z',
      processing_token: 'expired-worker', received_at: '2026-10-26T17:55:00Z',
      processing_attempts: 2,
    } })
    const result = await verifyAndReserveOpenWAWebhook(db as never, { rawBody, signature: signature(), nowMs })
    expect(result.duplicate).toBe(false)
    expect(result.inFlight).toBeUndefined()
    expect(result.processingToken).toMatch(/^[0-9a-f-]{36}$/)
    expect(receiptQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      processing_attempts: 3, processing_token: result.processingToken,
      processing_error: null,
    }))
    expect(receiptQuery.eq).toHaveBeenCalledWith('account_id', 'account-1')
    expect(receiptQuery.eq).toHaveBeenCalledWith('processing_token', 'expired-worker')
    expect(receiptQuery.is).toHaveBeenCalledWith('processed_at', null)
  })

  it('recovers legacy unfinished receipts without tokens only after their lease expires', async () => {
    const { db, receiptQuery } = dbFixture({ insertError: { code: '23505' }, receipt: {
      processed_at: null, processing_started_at: null, processing_token: null,
      received_at: '2026-10-26T17:50:00Z', processing_attempts: 0,
    } })
    const result = await verifyAndReserveOpenWAWebhook(db as never, { rawBody, signature: signature(), nowMs })
    expect(result.processingToken).toBeTruthy()
    expect(receiptQuery.is).toHaveBeenCalledWith('processing_token', null)
    expect(receiptQuery.is).toHaveBeenCalledWith('processing_started_at', null)
  })

  it('does not concurrently process an expired receipt when CAS is lost', async () => {
    const { db } = dbFixture({ insertError: { code: '23505' }, receipt: {
      processed_at: null, processing_started_at: '2026-10-26T17:55:00Z',
      processing_token: 'expired-worker', received_at: '2026-10-26T17:55:00Z',
      processing_attempts: 2,
    }, claimed: null })
    const result = await verifyAndReserveOpenWAWebhook(db as never, { rawBody, signature: signature(), nowMs })
    expect(result).toMatchObject({ duplicate: false, inFlight: true })
    expect(result.processingToken).toBeUndefined()
  })

  it('finalizes only the current tenant-scoped lease and retains failures as pending', async () => {
    const { db, receiptQuery } = dbFixture()
    await markOpenWAWebhookProcessed(db as never, 'account-1', 'connection-1', 'evt-1', 'lease-1')
    expect(receiptQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      processing_error: null, processing_started_at: null,
      processed_at: expect.any(String),
    }))
    expect(receiptQuery.eq).toHaveBeenCalledWith('processing_token', 'lease-1')
    expect(receiptQuery.eq).toHaveBeenCalledWith('account_id', 'account-1')
    await markOpenWAWebhookProcessed(db as never, 'account-1', 'connection-1', 'evt-1', 'lease-1', 'retryable_provider_failure')
    expect(receiptQuery.update).toHaveBeenLastCalledWith({
      processing_error: 'retryable_provider_failure', processed_at: null,
      processing_started_at: null,
    })
  })

  it('fails closed and logs only the database error code when reservation cannot be written', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { db } = dbFixture({ insertError: { code: '42P01', message: 'secret database contents' } })
      await expect(verifyAndReserveOpenWAWebhook(db as never, {
        rawBody, signature: signature(), nowMs,
      })).rejects.toThrow('receipt could not be reserved')
      expect(logger).toHaveBeenCalledWith('[openwa-webhook] receipt reservation rejected', { dbCode: '42P01' })
      expect(JSON.stringify(logger.mock.calls)).not.toContain('secret database contents')
    } finally {
      logger.mockRestore()
    }
  })

  it('classifies intake failures using safe fixed reason codes', () => {
    expect(classifyOpenWAWebhookRejection(new Error('OpenWA session is not active'))).toBe('inactive_session')
    expect(classifyOpenWAWebhookRejection(new Error('OpenWA webhook receipt could not be reserved'))).toBe('receipt_reservation_failed')
    expect(classifyOpenWAWebhookRejection(new Error('OpenWA webhook requires idempotencyKey, timestamp, sessionId, and event'))).toBe('missing_envelope_fields')
    expect(classifyOpenWAWebhookRejection(new Error('Invalid OpenWA webhook signature'))).toBe('invalid_signature')
    expect(classifyOpenWAWebhookRejection(new Error('Authorization: Bearer sensitive-key'))).toBe('unexpected_error')
    expect(classifyOpenWAWebhookRejection(null)).toBe('unexpected_error')
  })
})