import { createHmac, timingSafeEqual } from 'node:crypto'

// OpenWA signs exactly the serialized JSON body, without a timestamp prefix.
// The dispatch timestamp is part of that signed body and bounds replay age.
// Durable idempotency-key reservations reject duplicate deliveries separately.
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
  if (!value) return null
  const parsedMs = Date.parse(value)
  if (!Number.isFinite(parsedMs)) return null
  return Math.floor(parsedMs / 1000)
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
  if (timestampSeconds === null || !provided) return false

  const nowSeconds = Math.floor(nowMs / 1000)
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) return false

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest()
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}
