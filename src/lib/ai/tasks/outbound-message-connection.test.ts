import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveTaskMessageConnection,
  TaskMessageConnectionError,
} from './outbound-message-connection'

const tenant = 'tenant-a'
const conversationId = 'conversation-a'
type ConnectionRow = { id: string; account_id: string; provider: string; status: string; archived_at: string | null; session_id: string | null }
type InboundRow = { connection_id: string | null } | null

function fakeDb(connection: ConnectionRow | null, inbound?: InboundRow) {
  const reads: string[] = []
  const db = {
    from(table: string) {
      const where: Record<string, unknown> = {}
      const query = {
        select() { return query },
        eq(key: string, value: unknown) { where[key] = value; return query },
        order() { return query },
        limit() { return query },
        async maybeSingle() {
          reads.push(table)
          if (table === 'messages') {
            if (where.conversation_id !== conversationId || where.sender_type !== 'customer')
              return { data: null, error: new Error('invalid conversation scope') }
            return { data: inbound ?? null, error: null }
          }
          if (table === 'whatsapp_connections') {
            return { data: connection && connection.account_id === where.account_id && connection.id === where.id ? {
              id: connection.id, provider: connection.provider, status: connection.status,
              archived_at: connection.archived_at, session_id: connection.session_id,
            } : null, error: null }
          }
          throw new Error('Unexpected table')
        },
      }
      return query
    },
  }
  return { db: db as unknown as SupabaseClient, reads }
}

const wa: ConnectionRow = {
  id: 'connection-a', account_id: tenant, provider: 'openwa', status: 'ready',
  archived_at: null, session_id: 'session-a',
}

describe('Task-only WhatsApp provider selection (SOF-60)', () => {
  it('honors an explicit valid tenant connection and does not inspect other conversations', async () => {
    const { db, reads } = fakeDb(wa)
    // The production API only accepts UUIDs. Use one in this fixture.
    const id = '11111111-1111-4111-8111-111111111111'
    const scoped = fakeDb({ ...wa, id })
    await expect(resolveTaskMessageConnection(scoped.db, {
      accountId: tenant, conversationId,
      targetPolicy: { whatsappConnectionId: id },
    })).resolves.toEqual({ connectionId: id, provider: 'openwa' })
    expect(scoped.reads).toEqual(['whatsapp_connections'])
    expect(reads).toEqual([])
  })

  it('chooses the latest inbound exact connection only when none is explicit', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const { db, reads } = fakeDb({ ...wa, id }, { connection_id: id })
    expect(await resolveTaskMessageConnection(db, {
      accountId: tenant, conversationId, targetPolicy: {},
    })).toEqual({ connectionId: id, provider: 'openwa' })
    expect(reads).toEqual(['messages', 'whatsapp_connections'])
  })

  it('never falls back to Meta without an exact connection', async () => {
    const { db, reads } = fakeDb(wa, { connection_id: null })
    await expect(resolveTaskMessageConnection(db, {
      accountId: tenant, conversationId, targetPolicy: {},
    })).rejects.toMatchObject({ code: 'connection_selection_required' })
    expect(reads).toEqual(['messages'])
  })

  it('fails on archived, disconnected and cross-tenant connection rows', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const scenarios = [
      { row: { ...wa, id, archived_at: '2026-10-10T00:00:00Z' }, code: 'connection_archived' },
      { row: { ...wa, id, status: 'disconnected' }, code: 'connection_not_ready' },
      { row: { ...wa, id, account_id: 'foreign' }, code: 'connection_not_found' },
      { row: { ...wa, id, session_id: null }, code: 'connection_not_ready' },
    ]
    for (const { row, code } of scenarios) {
      const { db } = fakeDb(row)
      await expect(resolveTaskMessageConnection(db, {
        accountId: tenant, conversationId, targetPolicy: { whatsappConnectionId: id },
      })).rejects.toMatchObject({ code })
    }
  })

  it('rejects malformed IDs without contacting the database', async () => {
    const { db, reads } = fakeDb(wa)
    await expect(resolveTaskMessageConnection(db, {
      accountId: tenant, conversationId, targetPolicy: { whatsappConnectionId: 'not-a-uuid' },
    })).rejects.toBeInstanceOf(TaskMessageConnectionError)
    expect(reads).toEqual([])
  })

  it('permits an explicitly scoped connected Meta provider with unchanged template policy', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const { db } = fakeDb({
      id, account_id: tenant, provider: 'meta_cloud', status: 'connected',
      archived_at: null, session_id: null,
    })
    expect(await resolveTaskMessageConnection(db, {
      accountId: tenant, conversationId, targetPolicy: { whatsappConnectionId: id },
    })).toEqual({ connectionId: id, provider: 'meta_cloud' })
  })
})
