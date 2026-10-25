import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { verifyOpenWAWebhookSignature } from './webhook-signature'

const secret = 'test-webhook-secret'
const rawBody = JSON.stringify({ eventId: 'evt-1', sessionId: 'session-1', event: 'message' })
const timestamp = '1700000000'
const nowMs = 1700000000 * 1000

function signature(body = rawBody, ts = timestamp) {
  return createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex')
}

describe('verifyOpenWAWebhookSignature', () => {
  it('accepts a valid HMAC over timestamp and exact raw body', () => {
    expect(verifyOpenWAWebhookSignature({
      rawBody,
      signature: `sha256=${signature()}`,
      timestamp,
      secret,
      nowMs,
    })).toBe(true)
  })

  it('rejects tampered bodies and signatures', () => {
    expect(verifyOpenWAWebhookSignature({
      rawBody: `${rawBody} `,
      signature: signature(),
      timestamp,
      secret,
      nowMs,
    })).toBe(false)

    expect(verifyOpenWAWebhookSignature({
      rawBody,
      signature: '0'.repeat(64),
      timestamp,
      secret,
      nowMs,
    })).toBe(false)
  })

  it('rejects missing or malformed authentication headers', () => {
    expect(verifyOpenWAWebhookSignature({ rawBody, signature: null, timestamp, secret, nowMs })).toBe(false)
    expect(verifyOpenWAWebhookSignature({ rawBody, signature: signature(), timestamp: null, secret, nowMs })).toBe(false)
    expect(verifyOpenWAWebhookSignature({ rawBody, signature: 'not-hex', timestamp, secret, nowMs })).toBe(false)
  })

  it('rejects stale and future timestamps outside the replay window', () => {
    const staleTimestamp = String(Number(timestamp) - 301)
    const futureTimestamp = String(Number(timestamp) + 301)

    expect(verifyOpenWAWebhookSignature({
      rawBody,
      signature: signature(rawBody, staleTimestamp),
      timestamp: staleTimestamp,
      secret,
      nowMs,
    })).toBe(false)

    expect(verifyOpenWAWebhookSignature({
      rawBody,
      signature: signature(rawBody, futureTimestamp),
      timestamp: futureTimestamp,
      secret,
      nowMs,
    })).toBe(false)
  })
})
