import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
function source(path: string) { return readFileSync(new URL(path, import.meta.url), 'utf8') }
describe('OW-11 provider-neutral outbound isolation', () => {
  it('automation text resolves the conversation transport and keeps Meta templates Meta-only', () => { const text=source('../../automations/meta-send.ts'); expect(text).toContain('resolveConversationTransport'); expect(text).not.toContain('resolveMetaTransport'); expect(text).toContain("resolved.transport.provider!=='meta_cloud'"); expect(text).toContain('OpenWA does not use Meta approved-template policy') })
  it('Flow sends resolve the conversation transport and fail closed for OpenWA Meta-only interactive payloads', () => { const text=source('../../flows/meta-send.ts'); expect(text).toContain('resolveConversationTransport'); expect(text).not.toContain('resolveMetaTransport'); expect(text).toContain("resolved.transport.provider === 'openwa'"); expect(text).toContain("content.kind === 'interactive' || content.kind === 'template'") })
})
