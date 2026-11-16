import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
function source(path: string) { return readFileSync(new URL(path, import.meta.url), 'utf8') }
describe('provider-neutral outbound isolation', () => {
  it('automation/agent and Flow facades use the shared durable core', () => {
    const automation = source('../../automations/meta-send.ts')
    const flow = source('../../flows/meta-send.ts')
    expect(automation).toContain('sendMessageToConversation')
    expect(flow).toContain('sendMessageToConversation')
    expect(automation).toContain('resolveConversationTransport')
    expect(automation).toContain('OpenWA does not use Meta approved-template policy')
    expect(automation).not.toContain('sendTextMessage(')
    expect(flow).not.toContain('sendMediaMessage(')
  })
  it('uses stable per-step keys for automation and Flow sends', () => {
    expect(source('../../automations/engine.ts')).toContain('AUTOMATION_SEND_LOG_ID_REQUIRED')
    const flow = source('../../flows/engine.ts')
    expect(flow).toContain("engineIdempotencyKey: 'flow:'")
  })
})
