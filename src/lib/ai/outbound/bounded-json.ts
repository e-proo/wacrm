import { MAX_RESPONSE_BYTES } from './url-policy'

// ============================================================
// Bounded JSON body reader — closes the Phase 02 size-limit debt.
//
// Provider gateways can stream arbitrarily large bodies; reading a
// whole `Response` through `res.json()` with no cap is a memory DoS.
// This enforces MAX_RESPONSE_BYTES DURING streaming, not afterwards,
// and cancels the body when exceeded. Binary content types are
// rejected; mislabeled-but-valid JSON still parses after the cap.
// ============================================================

export class ResponseTooLargeError extends Error {
  readonly code = 'AI_PROVIDER_MALFORMED_RESPONSE'
  constructor() {
    super('Provider response exceeded the size limit.')
    this.name = 'ResponseTooLargeError'
  }
}

/**
 * Parse a provider `Response` body as JSON within a byte cap. Returns
 * `null` only for an empty/blank body; throws `ResponseTooLargeError`
 * when the (declared or streamed) size exceeds `maxBytes`, and
 * `ResponseMalformedError` for unparseable non-empty bodies.
 */
export async function readBoundedJson<T>(
  res: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<T | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ResponseTooLargeError()
  }

  const type = (res.headers.get('content-type') ?? '').toLowerCase()
  if (/image\/|video\/|audio\/|application\/pdf/.test(type)) {
    throw new ResponseTooLargeError()
  }

  const text = await readBodyCapped(res, maxBytes)
  if (!text || !text.trim()) return null
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ResponseMalformedError()
  }
}

export class ResponseMalformedError extends Error {
  readonly code = 'AI_PROVIDER_MALFORMED_RESPONSE'
  constructor() {
    super('Provider response was not valid JSON.')
    this.name = 'ResponseMalformedError'
  }
}

/** Read the full body (via arrayBuffer or text) enforcing the cap. */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  if (res.body) {
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          total += value.byteLength
          if (total > maxBytes) {
            await reader.cancel().catch(() => {})
            throw new ResponseTooLargeError()
          }
          chunks.push(value)
        }
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // already released or errored — ignore
      }
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.byteLength
    }
    return new TextDecoder().decode(merged)
  }
  // Fallback for streams without a body handle (rare in tests).
  const text = await res.text().catch(() => '')
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new ResponseTooLargeError()
  }
  return text
}
