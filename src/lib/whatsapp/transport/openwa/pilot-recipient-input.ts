/**
 * Browser-side convenience only. The server continues to validate the
 * canonical recipient and stores only an account/connection-scoped hash.
 *
 * Never infer a phone number from a verified WhatsApp @lid identity.
 */
export function normalizeTestRecipient(value: string): string | null {
  const raw = value.trim()
  if (/^[0-9]{5,20}@(c\.us|lid)$/.test(raw)) return raw
  if (!/^\+?[0-9 ()-]+$/.test(raw)) return null
  const digits = raw.replace(/[+ ()-]/g, '')
  return /^[1-9][0-9]{6,14}$/.test(digits) ? digits : null
}
