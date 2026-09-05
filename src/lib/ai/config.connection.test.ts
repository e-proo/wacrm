import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from './config'
import { generateReply } from './generate'

// Regression for the bug where an account configured ONLY through a
// provider connection (api_key = NULL, migration 043) was rejected as
// "not configured" by the old `if (!row.api_key) return null` guard.

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
  encrypt: (v: string) => `gcm:${v}`,
  isLegacyFormat: (v: string) => !v.startsWith('gcm:'),
}))
// Policy layer is covered by providers/shared.test.ts — stub it so no
// DNS happens from the openai adapter's custom-endpoint path here.
vi.mock('./outbound/url-policy', () => ({
  validateUrl: (raw: string) => ({ url: new URL(raw), error: null, blockedReason: null }),
  resolveTarget: async (url: URL) => ({
    host: url.hostname,
    port: 443,
    ips: ['93.184.216.34'],
    allowed: true,
    reason: '',
  }),
}))

const CONN_ROW = {
  id: 'conn-bi',
  account_id: 'acct-1',
  name: 'bi',
  preset_id: 'openai_compatible_custom',
  protocol: 'openai',
  api_root: 'https://api.b.ai/v1/',
  encrypted_api_key: 'gcm:some-cipher',
  connection_fingerprint: 'fp_deadbeef',
  status: 'verified',
  catalog: null,
  catalog_fetched_at: null,
  catalog_error_code: null,
  verified_at: '2026-09-05T07:00:00Z',
  created_by: null,
  created_at: '2026-09-05T07:00:00Z',
  updated_at: '2026-09-05T07:00:00Z',
}

function configRow(over: Record<string, unknown> = {}) {
  return {
    provider: 'openai',
    model: 'qwen3.8-flash',
    api_key: null, // ← the regression trigger
    system_prompt: 'sp',
    is_active: false,
    auto_reply_enabled: false,
    auto_reply_max_per_conversation: 3,
    handoff_agent_id: null,
    embeddings_api_key: null,
    chat_connection_id: 'conn-bi',
    chat_model: 'qwen3.8-flash',
    embedding_connection_id: 'conn-bi',
    embedding_model: null,
    embedding_dimensions: null,
    embedding_revision: null,
    embedding_pending_revision: null,
    embedding_reindex_state: 'legacy',
    ...over,
  }
}

// Explicit sequenced mock: ai_configs read first, then (for the
// connection path) ai_provider_connections.
function sequencedDb(steps: Array<Record<string, unknown> | null>): SupabaseClient {
  const remaining = [...steps]
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () =>
      Promise.resolve({ data: remaining.shift() ?? null, error: null }),
  }
  return { from: () => chain } as unknown as SupabaseClient
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('loadAiConfig — connection-only accounts (regression)', () => {
  it('resolves config + decrypted chat connection despite NULL api_key', async () => {
    vi.stubEnv('AI_MULTI_PROVIDER_ENABLED', 'true')
    const cfg = await loadAiConfig(
      sequencedDb([configRow(), CONN_ROW]),
      'acct-1',
      { requireActive: false },
    )
    expect(cfg).not.toBeNull()
    expect(cfg!.chat).not.toBeNull()
    expect(cfg!.chat!.apiKey).toBe('plain:gcm:some-cipher')
    expect(cfg!.chat!.apiRoot).toBe('https://api.b.ai/v1/')
    expect(cfg!.chat!.customEndpoint).toBe(true)
    expect(cfg!.chat!.model).toBe('qwen3.8-flash')
    expect(cfg!.apiKey).toBeNull() // legacy unused
  })

  it('still returns null for configs with neither legacy key nor link', async () => {
    vi.stubEnv('AI_MULTI_PROVIDER_ENABLED', 'true')
    const cfg = await loadAiConfig(
      sequencedDb([configRow({ chat_connection_id: null })]),
      'acct-1',
      { requireActive: false },
    )
    expect(cfg).toBeNull()
  })

  it('does not choke when the legacy column holds junk and a connection is linked', async () => {
    // The linked path must not decrypt the legacy column at all — even
    // a value that would throw stays harmless.
    vi.stubEnv('AI_MULTI_PROVIDER_ENABLED', 'true')
    const cfg = await loadAiConfig(
      sequencedDb([configRow({ api_key: 'not-even-ciphertext' }), CONN_ROW]),
      'acct-1',
      { requireActive: false },
    )
    expect(cfg).not.toBeNull()
    expect(cfg!.chat).not.toBeNull()
    expect(cfg!.apiKey).toBeNull()
  })

  it('generateReply drives the OPENAI adapter on the connection root and key', async () => {
    vi.stubEnv('AI_MULTI_PROVIDER_ENABLED', 'true')
    const cfg = (await loadAiConfig(
      sequencedDb([configRow(), CONN_ROW]),
      'acct-1',
      { requireActive: false },
    ))!
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      // The adapter body-reader parses via text() (bounded-json path).
      text: async () => JSON.stringify({ choices: [{ message: { content: 'Hello from b.ai' } }] }),
      json: async () => ({ choices: [{ message: { content: 'Hello from b.ai' } }] }),
      body: null,
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await generateReply({
      config: cfg,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(out.text).toBe('Hello from b.ai')
    // exact URL on the CUSTOM root — adapter got protocol+key from the connection
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.b.ai/v1/chat/completions')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer plain:gcm:some-cipher')
  })
})
