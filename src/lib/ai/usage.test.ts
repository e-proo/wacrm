import { describe, it, expect, vi } from 'vitest'
import { logAiUsage } from './usage'
import type { SupabaseClient } from '@supabase/supabase-js'

function fakeDb() {
  const insert = vi.fn().mockResolvedValue({ error: null })
  const db = { from: vi.fn(() => ({ insert })) }
  return { db: db as unknown as SupabaseClient, insert, from: db.from }
}

describe('logAiUsage', () => {
  it('inserts a row mapping normalized usage to the log columns', async () => {
    const { db, insert, from } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    expect(from).toHaveBeenCalledWith('ai_usage_log')
    expect(insert).toHaveBeenCalledWith({
      account_id: 'acct-1',
      conversation_id: 'conv-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      connection_id: null,
      prompt_tokens: 30,
      completion_tokens: 6,
      total_tokens: 36,
      usage_reported: true,
    })
  })

  it('records the connection for connection-driven calls', async () => {
    const { db, insert } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'playground',
      provider: 'openai',
      model: 'qwen3.8-flash',
      connectionId: 'conn-bi',
      usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
    })
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'playground',
        connection_id: 'conn-bi',
        total_tokens: 12,
        usage_reported: true,
      }),
    )
  })

  it('logs a CALL (zero tokens, usage_reported=false) when the provider reported no usage', async () => {
    // 044: gateways that omit usage blocks must still show spend activity.
    const { db, insert } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'openai',
      model: 'gpt-x',
      usage: null,
    })
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        usage_reported: false,
      }),
    )
  })

  it('never throws when the insert errors', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: 'boom' } })
    const db = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient
    await expect(
      logAiUsage(db, {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        mode: 'draft',
        provider: 'openai',
        model: 'gpt-x',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    ).resolves.toBeUndefined()
  })
})
