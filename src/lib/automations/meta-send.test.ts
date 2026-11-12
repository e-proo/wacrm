import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { OpenWAPreDispatchDenied } from '@/lib/whatsapp/transport/guardrails'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

const h = vi.hoisted(() => ({
  admin: vi.fn(),
  resolveTransport: vi.fn(),
  resolveRecipient: vi.fn(),
  send: vi.fn(),
  writes: [] as Array<{ table: string; payload: Record<string, unknown>; filters: Record<string, unknown> }>,
}))

vi.mock('./admin-client', () => ({ supabaseAdmin: h.admin }))
vi.mock('@/lib/whatsapp/transport/router', () => ({ resolveConversationTransport: h.resolveTransport }))
vi.mock('@/lib/whatsapp/transport/openwa/recipient', () => ({
  resolveOpenWAConversationRecipient: h.resolveRecipient,
}))
import { engineSendText } from './meta-send'

function testDb(): SupabaseClient {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      let updatePayload: Record<string, unknown> | null = null
      const q = {
        select: (_selection: string) => q,
        eq: (key: string, value: unknown) => { filters[key] = value; return q },
        is: (key: string, value: unknown) => { filters[key] = value; return q },
        maybeSingle: async () => ({
          data: table === 'conversations' ? { id: 'conv-1' }
            : table === 'contacts' ? { id: 'contact-1', phone: '967773000299' }
              : null,
          error: null,
        }),
        single: async () => ({ data: { id: 'reserved-bot-1' }, error: null }),
        insert: (_record: unknown) => q,
        update: (record: Record<string, unknown>) => { updatePayload = record; return q },
        then: (resolve: (value: unknown) => unknown) => {
          if (updatePayload) h.writes.push({ table, payload: updatePayload, filters: { ...filters } })
          return Promise.resolve(resolve({ data: null, error: null }))
        },
      }
      return q
    },
  } as unknown as SupabaseClient
}

const args = {
  accountId: 'acct-1', conversationId: 'conv-1',
  contactId: 'contact-1', userId: 'actor-1',
  aiAgentRunId: 'agent-run-1', text: 'consented test text',
}

describe('agent/automation message reservation reconciliation safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.writes.length = 0
    h.admin.mockReturnValue(testDb())
    h.resolveRecipient.mockResolvedValue('123456789012345@lid')
    h.resolveTransport.mockResolvedValue({
      connectionId: 'conn-1', transport: { provider: 'openwa', send: h.send },
    })
  })

  it('finalizes reserved bot identity only for a proven pre-provider Pilot denial', async () => {
    h.send.mockRejectedValue(new OpenWAPreDispatchDenied('OpenWA pilot cohort does not authorize this send'))
    await expect(engineSendText(args)).rejects.toMatchObject({ code: 'connection_restricted' })
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'acct-1', connectionId: 'conn-1',
      recipient: '123456789012345@lid', workload: 'agent',
      idempotencyKey: 'agent-run-1',
    }))
    expect(h.writes).toEqual([{
      table: 'messages', payload: { status: 'failed' },
      filters: {
        id: 'reserved-bot-1', conversation_id: 'conv-1', provider: 'openwa',
        status: 'sending', provider_message_id: null,
      },
    }])
  })

  it('leaves reserved identity sending on an ambiguous provider outcome', async () => {
    h.send.mockRejectedValue(new WhatsAppTransportError('ambiguous_outcome', 'Outcome unknown'))
    await expect(engineSendText(args)).rejects.toMatchObject({ code: 'ambiguous_outcome' })
    expect(h.writes).toEqual([])
  })

  it('does not treat an upstream connection_restricted provider failure as a proven pre-dispatch denial', async () => {
    h.send.mockRejectedValue(new WhatsAppTransportError('connection_restricted', 'Provider rejected request'))
    await expect(engineSendText(args)).rejects.toMatchObject({ code: 'connection_restricted' })
    expect(h.writes).toEqual([])
  })
})
