import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { verifyOpenWAWebhookSignature } from './webhook-signature'

const secret = 'test-webhook-secret'
const timestamp = '2026-10-26T18:00:00.000Z'
const rawBody = JSON.stringify({ idempotencyKey: 'evt-1', timestamp, sessionId: 'session-1', event: 'message.received' })
const nowMs = Date.parse(timestamp)

function signature(body = rawBody) {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

describe('OpenWA raw-body webhook signature', () => {
  it('accepts the exact signed OpenWA body and its dispatch timestamp', () => {
    expect(verifyOpenWAWebhookSignature({ rawBody, signature: 'sha256=' + signature(), timestamp, secret, nowMs })).toBe(true)
  })

  it('rejects body modifications, wrong signatures and missing auth', () => {
    expect(verifyOpenWAWebhookSignature({ rawBody: rawBody + ' ', signature: signature(), timestamp, secret, nowMs })).toBe(false)
    expect(verifyOpenWAWebhookSignature({ rawBody, signature: '0'.repeat(64), timestamp, secret, nowMs })).toBe(false)
    expect(verifyOpenWAWebhookSignature({ rawBody, signature: null, timestamp, secret, nowMs })).toBe(false)
    expect(verifyOpenWAWebhookSignature({ rawBody, signature: 'bad', timestamp, secret, nowMs })).toBe(false)
  })

  it('rejects missing, stale and future timestamps even when signed', () => {
    expect(verifyOpenWAWebhookSignature({ rawBody, signature: signature(), timestamp: null, secret, nowMs })).toBe(false)
    expect(verifyOpenWAWebhookSignature({ rawBody, signature: signature(), timestamp: 'not-a-date', secret, nowMs })).toBe(false)
    expect(verifyOpenWAWebhookSignature({ rawBody, signature: signature(), timestamp: new Date(nowMs - 301000).toISOString(), secret, nowMs })).toBe(false)
    expect(verifyOpenWAWebhookSignature({ rawBody, signature: signature(), timestamp: new Date(nowMs + 301000).toISOString(), secret, nowMs })).toBe(false)
  })
})
