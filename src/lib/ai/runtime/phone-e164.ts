// ============================================================
// E.164-style phone normalization for trusted-admin identity
// comparison.
//
// Phase 1 narrows the trusted-admin match to one channel
// ('whatsapp') and to one normalized address — the raw webhook
// value is never trusted. This module owns that normalization so
// every caller (webhook, registration form, revocation) agrees on
// what counts as the same number.
//
// Rules:
//   1. Strip everything that isn't a digit.
//   2. Reject if the result is empty or >15 digits (E.164 max).
//   3. Reject if the leading digit isn't 1–9.
//   4. Return the canonical digits-only string. We do NOT prepend
//      '+' here because the existing project stores numbers
//      digits-only (`normalizePhone` in whatsapp/phone-utils).
//      Adding '+' would silently break identity comparisons.
//
// `phonesMatch` (whatsapp/phone-utils) is for fuzzy inbound lookup
// (last-8 digits). `canonicalizeE164` here is for EXACT identity
// matching — they have different jobs.
// ============================================================

/**
 * Returns the canonical digits-only form of a phone number, or
 * `null` when the input is invalid. The result is suitable for
 * exact equality comparison between trusted-identity rows and
 * webhook-derived sender addresses.
 */
export function canonicalizeE164(input: string | null | undefined): string | null {
  if (!input) return null
  const digits = input.replace(/\D/g, '')
  if (digits.length === 0) return null
  // E.164: 7 to 15 digits, first digit non-zero.
  if (digits.length < 7 || digits.length > 15) return null
  if (!/^[1-9]/.test(digits)) return null
  return digits
}

/**
 * True when both inputs canonicalize to the same string. Two
 * invalid inputs compare as false (no canonical form ⇒ no match).
 */
export function e164Equals(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ca = canonicalizeE164(a)
  const cb = canonicalizeE164(b)
  if (!ca || !cb) return false
  return ca === cb
}
