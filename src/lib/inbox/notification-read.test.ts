import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { markConversationNotificationsRead } from './notification-read'

function notificationDb(error: { message: string } | null = null) {
  const filters: Array<[string, unknown]> = []
  const query: Record<string, unknown> = {}
  const update = vi.fn((_patch: Record<string, unknown>) => query)
  query.update = update
  query.eq = vi.fn((key: string, value: unknown) => {
    filters.push([key, value])
    return query
  })
  query.is = vi.fn(async (key: string, value: unknown) => {
    filters.push([key, value])
    return { error }
  })
  const from = vi.fn((_table: string) => query)
  return { db: { from } as unknown as SupabaseClient, from, update, filters }
}

describe('markConversationNotificationsRead', () => {
  it('acknowledges only the current user and tenant conversation', async () => {
    const { db, from, update, filters } = notificationDb()
    await markConversationNotificationsRead(db, {
      accountId: 'acct-1', conversationId: 'conv-1', userId: 'user-1',
    })
    expect(from).toHaveBeenCalledWith('notifications')
    expect(update).toHaveBeenCalledWith({ read_at: expect.any(String) })
    expect(filters).toEqual([
      ['account_id', 'acct-1'],
      ['conversation_id', 'conv-1'],
      ['user_id', 'user-1'],
      ['read_at', null],
    ])
  })

  it('never performs an unscoped update', async () => {
    const { db, from } = notificationDb()
    await markConversationNotificationsRead(db, {
      accountId: '', conversationId: 'conv-1', userId: 'user-1',
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('propagates a denied update rather than pretending the badge cleared', async () => {
    const { db } = notificationDb({ message: 'RLS denied' })
    await expect(markConversationNotificationsRead(db, {
      accountId: 'acct-1', conversationId: 'conv-1', userId: 'user-1',
    })).rejects.toMatchObject({ message: 'RLS denied' })
  })
})
