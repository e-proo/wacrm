import { describe, expect, it } from 'vitest'
import { normalizeTestRecipient } from './pilot-recipient-input'

describe('OW-13 TEST Pilot recipient entry assistance', () => {
  it('accepts a consenting international phone with plus, spaces or punctuation', () => {
    expect(normalizeTestRecipient('+967 7 123 45678')).toBe('967712345678')
    expect(normalizeTestRecipient('967712345678')).toBe('967712345678')
    expect(normalizeTestRecipient('+967 (7) 123-45678')).toBe('967712345678')
  })
  it('preserves provider-native c.us and LID identity exactly', () => {
    expect(normalizeTestRecipient('967712345678@c.us')).toBe('967712345678@c.us')
    expect(normalizeTestRecipient('12345678901234@lid')).toBe('12345678901234@lid')
  })
  it('rejects ambiguous and malformed identities rather than guessing', () => {
    for (const input of ['', '+', '00123456789', '123456', '1234567890123456',
      '967712345678@evil.test', 'abc123456789', '967+712345678', '967712345678@LID',
      '+967712345678@lid', '967712345678;status', '967٧١٢٣٤٥٦٧٨']) {
      expect(normalizeTestRecipient(input)).toBeNull()
    }
  })
})
