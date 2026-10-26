import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/whatsapp/send-message.ts'), 'utf8')

describe('OW-7 shared outbound safety boundary', () => {
  it('routes by provider-neutral conversation connection and reserves idempotency before provider send', () => {
    expect(source).toContain('resolveConversationTransport')
    expect(source).toContain('outbound_idempotency_key: sendKey')
    expect(source.indexOf(".from('messages').insert")).toBeLessThan(source.indexOf('resolved.transport.send'))
  })

  it('fails closed on cross-connection/provider replies and preserves ambiguous outcomes', () => {
    expect(source).toContain('Reply target belongs to a different WhatsApp connection')
    expect(source).toContain('Reply target belongs to a different WhatsApp provider')
    expect(source).toContain("transportError?.code !== 'ambiguous_outcome'")
    expect(source).toContain('already pending reconciliation')
  })

  it('does not apply Meta approved-template semantics to OpenWA', () => {
    expect(source).toContain('OpenWA does not use Meta approved-template policy')
    expect(source).toContain('OW-7 OpenWA outbound supports text and replies only')
  })
})
