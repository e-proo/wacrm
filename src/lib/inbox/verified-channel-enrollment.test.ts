import { describe, expect, it } from 'vitest'
import { strictOwnPhone } from './verified-channel-enrollment'
describe('verified own identity (never infer from native chat or number-shaped LID)', () => {
  it('normalizes only unambiguous E.164 digits', () => {
    expect(strictOwnPhone('+15550000111')).toBe('15550000111')
    expect(strictOwnPhone('15550000111')).toBe('15550000111')
  })
  it('rejects aliases and malformed identity', () => {
    for (const input of [null,undefined,15550000111,'15550000111@lid','15550000111@c.us',' 15550000111','0015550000111','+0123456789','123','+1234567890123456','1555-000-0111'])
      expect(strictOwnPhone(input)).toBeNull()
  })
})
