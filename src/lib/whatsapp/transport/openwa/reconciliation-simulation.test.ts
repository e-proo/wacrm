import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { applyWhatsAppStatus } from '@/lib/whatsapp/status-lifecycle'
import { resolveConversationTransport } from '@/lib/whatsapp/transport/router'
import { resolveOpenWAConversationRecipient } from './recipient'
import { OpenWAClient } from './client'
import type { WhatsAppTransportSendRequest } from '../types'

vi.mock('@/lib/whatsapp/transport/router', () => ({
  resolveConversationTransport: vi.fn(),
}))
vi.mock('@/lib/whatsapp/transport/openwa/recipient', () => ({
  resolveOpenWAConversationRecipient: vi.fn(),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: vi.fn() }))

interface SimulatedMessage {
  id: string
  conversation_id: string
  outbound_idempotency_key: string
  provider: string
  connection_id: string
  status: string
  provider_message_id: string | null
  message_id: string | null
}

function simulationDb() {
  // Memory-only database. In particular, there is no Supabase client,
  // OpenWA service, external HTTP request or real WhatsApp destination.
  const messages: SimulatedMessage[] = []
  const writes: Array<{ table: string; operation: string }> = []
  const db = {
    from(table: string) {
      const where: Record<string, unknown> = {}
      let operation: 'select' | 'insert' | 'update' = 'select'
      let payload: Record<string, unknown> = {}
      const matches = (row: Record<string, unknown>) =>
        Object.entries(where).every(([key, value]) => row[key] === value)
      const q = {
        select(_columns?: string) { return q },
        eq(key: string, value: unknown) { where[key] = value; return q },
        insert(row: Record<string, unknown>) {
          operation = 'insert'
          payload = row
          return q
        },
        update(row: Record<string, unknown>) {
          operation = 'update'
          payload = row
          return q
        },
        async maybeSingle() {
          if (table === 'whatsapp_connections') {
            return { data: matches({ id: 'conn-1', account_id: 'acct-1', provider: 'openwa' }) ? { id: 'conn-1' } : null, error: null }
          }
          if (table === 'broadcast_recipients') return { data: null, error: null }
          if (table !== 'messages') return { data: null, error: null }
          if (operation === 'insert') {
            const existing = messages.find((row) =>
              row.conversation_id === payload.conversation_id &&
              row.outbound_idempotency_key === payload.outbound_idempotency_key,
            )
            if (existing) return { data: null, error: { code: '23505', message: 'unique constraint' } }
            const row: SimulatedMessage = {
              ...(payload as unknown as SimulatedMessage),
              id: 'reserved-1',
              message_id: null,
              provider_message_id: null,
            }
            messages.push(row)
            writes.push({ table, operation: 'insert' })
            return { data: { ...row }, error: null }
          }
          return { data: messages.find((row) => matches(row as unknown as Record<string, unknown>)) ?? null, error: null }
        },
        async single() {
          if (table === 'conversations') {
            return {
              data: {
                id: 'conv-1',
                account_id: 'acct-1',
                contact: { id: 'contact-1', phone: '+15551234567' },
              },
              error: null,
            }
          }
          return { data: null, error: null }
        },
        then(resolve: (result: { error: null }) => unknown) {
          if (table === 'messages' && operation === 'update') {
            const row = messages.find((candidate) => matches(candidate as unknown as Record<string, unknown>))
            if (row) Object.assign(row, payload)
            writes.push({ table, operation: 'update' })
          }
          return Promise.resolve(resolve({ error: null }))
        },
      }
      return q
    },
  }
  return { db: db as unknown as SupabaseClient, messages, writes }
}

const simulatedSend = {
  conversationId: 'conv-1',
  connectionId: 'conn-1',
  messageType: 'text',
  contentText: 'OW12 simulated timeout only',
  idempotencyKey: 'ow12-simulation-stable-key',
}

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('OW-12 simulated ambiguous outbound reconciliation (NO real sends)', () => {
  it('reserves once, preserves sending after timeout, and blocks a retry with the same key', async () => {
    const state = simulationDb()
    const fetchImpl = vi.fn((_url: URL | RequestInfo, options?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('simulated timeout'), { name: 'AbortError' }))
        }, { once: true })
      }),
    ) as unknown as typeof fetch

    const client = new OpenWAClient({
      baseUrl: 'https://gateway.example.com',
      apiKey: 'simulation-only-not-real',
      timeoutMs: 5,
      fetchImpl,
    })
    const send = vi.fn(async (request: WhatsAppTransportSendRequest) => {
      if (request.content.kind !== 'text') throw new Error('Unexpected non-text simulation')
      const result = await client.sendText({
        sessionId: 'simulated-session',
        to: request.recipient,
        text: request.content.text,
        idempotencyKey: request.idempotencyKey,
      })
      return {
        provider: 'openwa' as const,
        connectionId: 'conn-1',
        providerMessageId: result.providerMessageId,
      }
    })
    vi.mocked(resolveConversationTransport).mockResolvedValue({
      connectionId: 'conn-1',
      transport: { provider: 'openwa', send },
    })
    vi.mocked(resolveOpenWAConversationRecipient).mockResolvedValue('12345678901@lid')

    const firstError = await sendMessageToConversation(state.db, 'acct-1', simulatedSend).catch((error: unknown) => error)
    expect(firstError).toMatchObject({ code: 'ambiguous_outcome', status: 409 })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({
      status: 'sending',
      provider: 'openwa',
      connection_id: 'conn-1',
      provider_message_id: null,
      outbound_idempotency_key: simulatedSend.idempotencyKey,
    })
    expect(state.writes).toEqual([{ table: 'messages', operation: 'insert' }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1].headers['idempotency-key']).toBe(simulatedSend.idempotencyKey)

    const retryError = await sendMessageToConversation(state.db, 'acct-1', simulatedSend).catch((error: unknown) => error)
    expect(retryError).toMatchObject({ code: 'ambiguous_outcome', status: 409 })
    expect(state.messages).toHaveLength(1)
    expect(state.writes).toEqual([{ table: 'messages', operation: 'insert' }])
    expect(send).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not treat an unmatched late ACK as proof an ambiguous send succeeded', async () => {
    const state = simulationDb()
    state.messages.push({
      id: 'reserved-1',
      conversation_id: 'conv-1',
      outbound_idempotency_key: simulatedSend.idempotencyKey,
      provider: 'openwa',
      connection_id: 'conn-1',
      status: 'sending',
      message_id: null,
      provider_message_id: null,
    })

    expect(await applyWhatsAppStatus(state.db, {
      provider: 'openwa',
      accountId: 'acct-1',
      connectionId: 'conn-1',
      providerMessageId: 'unmatched-native-id',
      status: 'read',
    })).toBe('unknown')
    expect(state.messages[0]).toMatchObject({ status: 'sending', provider_message_id: null })
    expect(state.writes).toHaveLength(0)

    // Even a plausible native ID from a different connection/account
    // must not update or reconcile this reservation.
    expect(await applyWhatsAppStatus(state.db, {
      provider: 'openwa',
      accountId: 'other-account',
      connectionId: 'conn-1',
      providerMessageId: 'unmatched-native-id',
      status: 'read',
    })).toBe('unknown')
    expect(state.writes).toHaveLength(0)
  })

  it('does not invent a provider lookup or resend when asked to reconcile an unknown key', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const client = new OpenWAClient({
      baseUrl: 'https://gateway.example.com',
      apiKey: 'simulation-only-not-real',
      fetchImpl,
    })
    await expect(client.reconcileOutbound('simulated-session', simulatedSend.idempotencyKey))
      .rejects.toMatchObject({ code: 'ambiguous_outcome' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
