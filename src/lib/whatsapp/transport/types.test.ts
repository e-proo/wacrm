import { describe, expect, it } from 'vitest'

import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

describe('WhatsAppTransportError', () => {
  it('preserves the provider-neutral error code and cause', () => {
    const cause = new Error('provider detail')
    const error = new WhatsAppTransportError('ambiguous_outcome', 'send outcome is unknown', cause)

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('WhatsAppTransportError')
    expect(error.code).toBe('ambiguous_outcome')
    expect(error.message).toBe('send outcome is unknown')
    expect(error.cause).toBe(cause)
  })
})
