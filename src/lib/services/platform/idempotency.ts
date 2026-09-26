export interface IdempotencyKeyOptions {
  minLength?: number
  maxLength?: number
  trim?: boolean
}

export function normalizeIdempotencyKey(
  value: string | null | undefined,
  options: IdempotencyKeyOptions = {},
): string | null {
  const minLength = options.minLength ?? 8
  const maxLength = options.maxLength
  const raw = value ?? ''
  const key = options.trim ? raw.trim() : raw

  if (key.length < minLength) return null
  if (maxLength !== undefined && key.length > maxLength) return null
  return key
}


export type IdempotencyKeyPart =
  | string
  | number
  | boolean
  | null
  | undefined

export interface ComposeIdempotencyKeyOptions {
  maxLength?: number
}

/**
 * Compose an internal idempotency key while preserving the historical
 * colon-separated format used by Change Requests.
 *
 * This intentionally truncates exactly like the previous call sites so Phase 3
 * does not silently change replay identity for normal-sized existing keys.
 */
export function composeIdempotencyKey(
  parts: readonly IdempotencyKeyPart[],
  options: ComposeIdempotencyKeyOptions = {},
): string {
  const maxLength = options.maxLength ?? 1200
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new Error('IDEMPOTENCY_MAX_LENGTH_INVALID')
  }
  const raw = parts
    .map((part) => (part === null || part === undefined ? '' : String(part)))
    .join(':')
  return raw.slice(0, maxLength)
}
