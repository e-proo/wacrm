import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveOpenWACredentials } from './credentials'
import { parseOpenWAWebhookEnvelope, verifyAndReserveOpenWAWebhook } from './webhook'

vi.mock('./credentials', () => ({ resolveOpenWACredentials: vi.fn() }))

const mockedResolveCredentials = vi.mocked(resolveOpenWACredentials)
const rawBody = JSON.stringify({ eventId: 'evt-1', sessionId: 'session-1', instanceId: 'instance-1', event: 'message', data: { text: 'hello' } })
const timestamp = '1700000000'
const nowMs = 1700000000 * 1000
const webhookSecret = 'webhook-secret'

function signature() {
  return createHmac('sha256', webhookSecret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')
}

function dbFixture(options: { connection?: unknown; connectionError?: unknown; insertError?: unknown } = {}) {
  const connection = options.connection ?? {
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

  const receiptQuery = {
    insert: vi.fn().mockResolvedValue({ error: options.insertError ?? null }),
  }

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
    expect(() => parseOpenWAWebhookEnvelope('{}')).toThrow('requires eventId, sessionId, and event')
  })

  it('resolves session identity first, verifies signature, and reserves the event', async () => {
    const { db, connectionQuery, receiptQuery } = dbFixture()
    const result = await verifyAndReserveOpenWAWebhook(db as never, {
      rawBody, signature: signature(), timestamp, nowMs,
    })

    expect(connectionQuery.eq).toHaveBeenCalledWith('provider', 'openwa')
    expect(connectionQuery.eq).toHaveBeenCalledWith('session_id', 'session-1')
    expect(connectionQuery.eq).toHaveBeenCalledWith('instance_id', 'instance-1')
    expect(mockedResolveCredentials).toHaveBeenCalledWith(db, 'account-1', 'connection-1')
    expect(receiptQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      account_id: 'account-1', connection_id: 'connection-1', provider: 'openwa', provider_event_id: 'evt-1',
    }))
    expect(result.duplicate).toBe(false)
  })

  it('rejects unknown sessions before accepting an event', async () => {
    const { db } = dbFixture({ connection: null })
    await expect(verifyAndReserveOpenWAWebhook(db as never, {
      rawBody, signature: signature(), timestamp, nowMs,
    })).rejects.toThrow('Unknown OpenWA session')
    expect(mockedResolveCredentials).not.toHaveBeenCalled()
  })

  it('rejects missing webhook credentials and invalid signatures', async () => {
    const { db } = dbFixture()
    mockedResolveCredentials.mockResolvedValueOnce({
      accountId: 'account-1', connectionId: 'connection-1', baseUrl: 'https://openwa.example.com', apiKey: 'api-key',
    })
    await expect(verifyAndReserveOpenWAWebhook(db as never, {
      rawBody, signature: signature(), timestamp, nowMs,
    })).rejects.toThrow('webhook secret is not configured')

    mockedResolveCredentials.mockResolvedValueOnce({
      accountId: 'account-1', connectionId: 'connection-1', baseUrl: 'https://openwa.example.com', apiKey: 'api-key', webhookSecret,
    })
    await expect(verifyAndReserveOpenWAWebhook(db as never, {
      rawBody, signature: '0'.repeat(64), timestamp, nowMs,
    })).rejects.toThrow('Invalid OpenWA webhook signature')
  })

  it('treats the receipt unique constraint as an idempotent duplicate', async () => {
    const { db } = dbFixture({ insertError: { code: '23505' } })
    const result = await verifyAndReserveOpenWAWebhook(db as never, {
      rawBody, signature: signature(), timestamp, nowMs,
    })
    expect(result.duplicate).toBe(true)
  })

  it('fails closed when durable reservation cannot be written', async () => {
    const { db } = dbFixture({ insertError: { code: 'XX000' } })
    await expect(verifyAndReserveOpenWAWebhook(db as never, {
      rawBody, signature: signature(), timestamp, nowMs,
    })).rejects.toThrow('receipt could not be reserved')
  })
})
