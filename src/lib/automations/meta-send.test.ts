import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { OpenWAPreDispatchDenied } from '@/lib/whatsapp/transport/guardrails'
const h = vi.hoisted(() => ({
  core: vi.fn(), resolve: vi.fn(), admin: vi.fn(),
}))
vi.mock('./admin-client', () => ({ supabaseAdmin: h.admin }))
vi.mock('@/lib/whatsapp/transport/router', () => ({ resolveConversationTransport: h.resolve }))
vi.mock('@/lib/whatsapp/send-message', () => ({ sendMessageToConversation: h.core }))
import { engineSendText, engineSendTemplate } from './meta-send'
const base = { accountId: 'account-1', userId: 'actor-1', conversationId: 'conversation-1', contactId: 'contact-1', text: 'Hello', aiAgentRunId: 'run-1' }
describe('unified agent/automation outbound facade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.admin.mockReturnValue({ from: () => { throw new Error('No frozen connection read expected') } } as unknown as SupabaseClient)
    h.resolve.mockResolvedValue({ connectionId: 'openwa-1', transport: { provider: 'openwa' } })
    h.core.mockResolvedValue({ messageId: 'local-1', whatsappMessageId: 'native-1' })
  })
  it('sends an agent with a stable key through the shared reservation core', async () => {
    expect(await engineSendText(base)).toEqual({ local_message_id: 'local-1', whatsapp_message_id: 'native-1' })
    expect(h.core).toHaveBeenCalledWith(expect.anything(), base.accountId, expect.objectContaining({
      senderType: 'bot', pauseActiveFlows: false, expectedContactId: base.contactId,
      idempotencyKey: 'run-1', aiAgentRunId: 'run-1', connectionId: 'openwa-1',
      workload: 'agent', preservePreDispatchError: true,
    }))
  })
  it('preserves the typed pre-dispatch denial for Agent Task reconciliation state', async () => {
    h.core.mockRejectedValue(new OpenWAPreDispatchDenied('Blocked before provider dispatch'))
    await expect(engineSendText(base)).rejects.toBeInstanceOf(OpenWAPreDispatchDenied)
  })
  it('rejects Meta templates on OpenWA before invoking the core', async () => {
    await expect(engineSendTemplate({ ...base, templateName: 'approved_only' })).rejects.toMatchObject({ code: 'unsupported_capability' })
    expect(h.core).not.toHaveBeenCalled()
  })
  it('passes automation keys to the core without falsely classifying as agents', async () => {
    await engineSendText({ ...base, aiAgentRunId: undefined, engineIdempotencyKey: 'automation:log:step' })
    expect(h.core).toHaveBeenCalledWith(expect.anything(), base.accountId, expect.objectContaining({
      workload: 'automation', idempotencyKey: 'automation:log:step',
      engineIdempotencyKey: 'automation:log:step',
    }))
  })
})
