// ============================================================
// Decimal arithmetic for service pricing + exchange rates.
//
// Phase 2 uses string-based decimal math via the `decimal.js`
// library to avoid JavaScript's binary-float surprises (a 6 per
// 1000 fee on 10,500 must equal exactly 63 YER, not 62.999…7).
//
// Numbers cross the wire as STRINGS (per plan 06_DATA_MODEL §2).
// This module:
//   • normalizes user input (strips whitespace, validates
//     non-negative, allows an explicit negative sign for refunds),
//   • parses via Decimal,
//   • rounds via a HALF-UP mode by default (Phase 2 keeps the
//     rounding semantics in the rule body, not hardcoded),
//   • serializes back to a canonical 2/4/8-decimal string
//     matching the column scale.
//
// Decimal.js is the right tool here because:
//   • it handles big numbers (>2^53) cleanly,
//   • it offers explicit rounding modes (no IEEE-754 ambiguity),
//   • it serializes to a deterministic string format.
// ============================================================

import { Decimal } from 'decimal.js'

// Configure once. `Decimal.set` is global; doing it at module
// load keeps the rest of the codebase free of configuration
// ceremony.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP })

export interface ParseDecimalOptions {
  /** When true, allows a leading '-' sign. Default false. */
  allowNegative?: boolean
  /** When true, refuses the value '0'. Default false. */
  rejectZero?: boolean
}

/**
 * Parse a user-supplied amount string into a Decimal. Returns
 * `null` for any input that can't be parsed cleanly — callers
 * surface the error to the UI rather than throwing.
 */
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
  // Reject anything that's not digit / decimal separator / sign.
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null
  if (!opts.allowNegative && trimmed.startsWith('-')) return null
  const d = new Decimal(trimmed)
  if (opts.rejectZero && d.isZero()) return null
  return d
}

/**
 * Serialize a Decimal to a fixed-scale string. Default 2 decimals
 * (matching most currencies); callers pass `precision` for finer
 * units (e.g. 4 decimals for fee rounding per plan §7.2).
 */
export function formatDecimal(
  value: Decimal | string | number,
  precision = 2,
): string {
  const d = value instanceof Decimal ? value : new Decimal(value)
  return d.toFixed(precision)
}

/**
 * Compare two decimals with a tolerance. Useful for "are these
 * amounts equal" checks across DB ↔ in-memory arithmetic where
 * rounding at different scales might produce a 1-ulp drift.
 */
export function decimalsEqual(
  a: Decimal | string | number,
  b: Decimal | string | number,
  tolerance = new Decimal('0.0001'),
): boolean {
  const da = a instanceof Decimal ? a : new Decimal(a)
  const db = b instanceof Decimal ? b : new Decimal(b)
  return da.minus(db).abs().lte(tolerance)
}
