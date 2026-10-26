import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

describe('OW-6 legacy Meta outbound isolation', () => {
  it('guards automation text/template sends before Meta transport resolution', () => {
    const text = source('../../../automations/meta-send.ts')
    const guard = text.indexOf('await assertConversationAllowsMetaOutbound')
    const resolve = text.indexOf('await resolveMetaTransport')
    expect(guard).toBeGreaterThan(-1)
    expect(resolve).toBeGreaterThan(guard)
  })

  it('guards Flow sends before Meta transport resolution', () => {
    const text = source('../../../flows/meta-send.ts')
    const guard = text.indexOf('await assertConversationAllowsMetaOutbound')
    const resolve = text.indexOf('await resolveMetaTransport')
    expect(guard).toBeGreaterThan(-1)
    expect(resolve).toBeGreaterThan(guard)
  })
})
