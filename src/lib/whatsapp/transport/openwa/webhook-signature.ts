import { createHmac, timingSafeEqual } from 'node:crypto'

const DEFAULT_TOLERANCE_SECONDS = 5 * 60

export interface OpenWAWebhookVerificationInput {
  rawBody: string
  signature: string | null
  timestamp: string | null
  secret: string
  nowMs?: number
  toleranceSeconds?: number
}

function parseSignature(value: string | null): Buffer | null {
  if (!value) return null
  const normalized = value.trim().replace(/^sha256=/i, '')
  if (!/^[a-f0-9]{64}$/i.test(normalized)) return null
  return Buffer.from(normalized, 'hex')
}

function parseTimestamp(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const seconds = Number(value)
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null
  return seconds
}

export function verifyOpenWAWebhookSignature({
  rawBody,
  signature,
  timestamp,
  secret,
  nowMs = Date.now(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
}: OpenWAWebhookVerificationInput): boolean {
  if (!secret || toleranceSeconds <= 0) return false

  const timestampSeconds = parseTimestamp(timestamp)
  const provided = parseSignature(signature)
  if (!timestampSeconds || !provided) return false

  const nowSeconds = Math.floor(nowMs / 1000)
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) return false

  // The signed payload is versioned and unambiguous: timestamp + literal dot +
  // exact raw request body. The OpenWA deployment must be configured to emit
  // the same contract before this endpoint is enabled.
  const expected = createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`, 'utf8')
    .digest()

  return provided.length === expected.length && timingSafeEqual(provided, expected)
}
