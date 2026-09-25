import { Decimal } from 'decimal.js'

/** Shared Decimal configuration for every business domain. */
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP })

export { Decimal }

export interface ParseDecimalOptions {
  allowNegative?: boolean
  rejectZero?: boolean
}

export function parseDecimal(
  input: string | number | null | undefined,
  opts: ParseDecimalOptions = {},
): Decimal | null {
  if (input === null || input === undefined) return null
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null
    if (!opts.allowNegative && input < 0) return null
    if (opts.rejectZero && input === 0) return null
    return new Decimal(input)
  }
  const trimmed = input.trim().replace(/\s+/g, '')
  if (trimmed === '') return null
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null
  if (!opts.allowNegative && trimmed.startsWith('-')) return null
  const value = new Decimal(trimmed)
  if (opts.rejectZero && value.isZero()) return null
  return value
}

export function formatDecimal(
  value: Decimal | string | number,
  precision = 2,
): string {
  const decimal = value instanceof Decimal ? value : new Decimal(value)
  return decimal.toFixed(precision)
}

export function decimalsEqual(
  a: Decimal | string | number,
  b: Decimal | string | number,
  tolerance = new Decimal('0.0001'),
): boolean {
  const left = a instanceof Decimal ? a : new Decimal(a)
  const right = b instanceof Decimal ? b : new Decimal(b)
  return left.minus(right).abs().lte(tolerance)
}
