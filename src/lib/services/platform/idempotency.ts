export interface IdempotencyKeyOptions {
  minLength?: number
  maxLength?: number
}

export function normalizeIdempotencyKey(
  value: string | null | undefined,
  options: IdempotencyKeyOptions = {},
): string | null {
  const minLength = options.minLength ?? 8
  const maxLength = options.maxLength
  const key = value?.trim() ?? ''

  if (key.length < minLength) return null
  if (maxLength !== undefined && key.length > maxLength) return null
  return key
}
