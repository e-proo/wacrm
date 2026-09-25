/** Shared service-platform currency-code contract. */
export const CURRENCY_CODE_PATTERN = /^[A-Z_]{3,8}$/

export function normalizeCurrencyCode(
  value: string | null | undefined,
): string | null {
  if (value == null) return null
  const normalized = value.trim().toUpperCase()
  return CURRENCY_CODE_PATTERN.test(normalized) ? normalized : null
}

export function isCurrencyCode(value: string | null | undefined): boolean {
  return normalizeCurrencyCode(value) !== null
}
