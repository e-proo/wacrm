import { describe, expect, it } from 'vitest'
import { sanitizeToolResultForModel } from './current-executor-registry'

describe('sanitizeToolResultForModel', () => {
  it('removes change-request approval secrets recursively before model context', () => {
    const result = sanitizeToolResultForModel({
      ok: true,
      safe_to_show: true,
      data: {
        confirmationCode: '9999',
        change_request: {
          id: 'cr-1',
          code: 42,
          confirmation_code: '1234',
          nested: {
            confirmation_code_hash: 'hash-a',
            confirmationCodeHash: 'hash-b',
            status: 'pending',
          },
        },
        rows: [
          { confirmation_code: '1111', value: 7 },
          { value: 8 },
        ],
      },
    })

    expect(result).toEqual({
      ok: true,
      safe_to_show: true,
      data: {
        change_request: {
          id: 'cr-1',
          code: 42,
          nested: { status: 'pending' },
        },
        rows: [{ value: 7 }, { value: 8 }],
      },
    })
  })

  it('preserves failures and null data unchanged', () => {
    const result = {
      ok: false as const,
      data: null,
      safe_to_show: false,
      code: 'NOPE',
      message: 'Nope',
    }
    expect(sanitizeToolResultForModel(result)).toBe(result)
  })
})
