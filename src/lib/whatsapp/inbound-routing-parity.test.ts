import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

describe('OW-6 shared inbound routing parity', () => {
  it('routes both Meta and OpenWA through the same normalized business processor', () => {
    const metaRoute = source('../../app/api/whatsapp/webhook/route.ts')
    const openwaRoute = source('../../app/api/whatsapp/openwa/webhook/route.ts')

    expect(metaRoute).toContain('normalizeMetaInboundMessage')
    expect(metaRoute).toContain('processNormalizedInboundMessage')
    expect(openwaRoute).toContain('normalizeOpenWAInboundMessage')
    expect(openwaRoute).toContain('processNormalizedInboundMessage')
  })

  it('keeps provider-neutral persistence in the shared processor', () => {
    const processor = source('./inbound-processor.ts')
    expect(processor).toContain('provider: message.provider')
    expect(processor).toContain('connection_id: message.connectionId')
    expect(processor).toContain('provider_message_id: message.providerMessageId')
  })
})
