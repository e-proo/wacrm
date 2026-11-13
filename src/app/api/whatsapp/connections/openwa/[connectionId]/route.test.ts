import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  logout: vi.fn(),
  credentials: vi.fn(),
}))

vi.mock('@/lib/whatsapp/transport/openwa/session-auth', () => ({
  requireOpenWASessionAdmin: h.auth,
}))
vi.mock('@/lib/whatsapp/transport/openwa/session-lifecycle', () => ({
  logoutOpenWAConnection: h.logout,
  reconnectOpenWAConnection: vi.fn(),
  refreshOpenWAConnectionStatus: vi.fn(),
}))
vi.mock('@/lib/whatsapp/transport/openwa/credentials', () => ({
  resolveOpenWAClient: h.credentials,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: vi.fn() }))

import { DELETE, POST } from './route'

const CONNECTION = '11111111-2222-4333-8444-555555555555'
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
function context(id = CONNECTION) {
  return { params: Promise.resolve({ connectionId: id }) }
}
function request(action = 'remove_from_wacrm') {
  return new Request('https://localhost/api/whatsapp/connections/openwa/' + CONNECTION, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  })
}

describe('OpenWA session removal from WACRM', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.rpc.mockResolvedValue({ data: 'archived', error: null })
    h.auth.mockResolvedValue({
      accountId: ACCOUNT, user: { id: ACTOR },
      adminDb: { rpc: h.rpc },
    })
  })

  it('archives only the authenticated tenant connection and never calls OpenWA logout', async () => {
    const response = await POST(request(), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ removed: true, already_removed: false })
    expect(h.rpc).toHaveBeenCalledWith('archive_openwa_connection', {
      p_account_id: ACCOUNT, p_connection_id: CONNECTION, p_actor_id: ACTOR,
    })
    expect(h.logout).not.toHaveBeenCalled()
    expect(h.credentials).not.toHaveBeenCalled()
  })

  it.each([
    ['pending_sends', 'Pending OpenWA sends'],
    ['pending_webhooks', 'Unfinished signed OpenWA events'],
  ])('blocks removal while %s are unresolved', async (code, description) => {
    h.rpc.mockResolvedValue({ data: code, error: null })
    const response = await POST(request(), context())
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.code).toBe(code)
    expect(body.error).toContain(description)
    expect(h.logout).not.toHaveBeenCalled()
  })

  it('handles an already archived connection idempotently', async () => {
    h.rpc.mockResolvedValue({ data: 'already_archived', error: null })
    const response = await POST(request(), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ removed: true, already_removed: true })
  })

  it('returns 404 for a missing or cross-account connection', async () => {
    h.rpc.mockResolvedValue({ data: 'not_found', error: null })
    const response = await POST(request(), context())
    expect(response.status).toBe(404)
    expect((await response.json()).code).toBe('not_found')
  })

  it('requires server-admin authorization and does not touch the database on denial', async () => {
    h.auth.mockRejectedValue(new Error('Private auth token should never leak'))
    const response = await POST(request(), context())
    expect(response.status).toBe(502)
    expect(JSON.stringify(await response.json())).not.toContain('Private auth token')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('rejects invalid connection IDs before invoking the archival RPC', async () => {
    const response = await POST(request(), context('../bad'))
    expect(response.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('never exposes provider or SQL errors to the user', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '42P01', message: 'secret credentials and hostname' } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await POST(request(), context())
      expect(response.status).toBe(502)
      const payload = await response.json()
      expect(payload.code).toBe('archive_failed')
      expect(JSON.stringify(payload)).not.toContain('secret credentials')
      expect(h.logout).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })

  it('retains historical DELETE logout behavior (distinct from removal)', async () => {
    h.logout.mockResolvedValue({ status: 'logged_out' })
    const response = await DELETE(new Request('https://localhost/', { method: 'DELETE' }), context())
    expect(response.status).toBe(200)
    expect(h.logout).toHaveBeenCalledTimes(1)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})

describe('OpenWA signed webhook configuration', () => {
  const previousUrl = process.env.OPENWA_WEBHOOK_URL
  const previousProject = process.env.NEXT_PUBLIC_SUPABASE_URL
  const savedWebhookUrls: string[] = []
  let session: { session_id: string | null } | null
  let configure: ReturnType<typeof vi.fn>
  let lookupFilters: Array<[string, unknown]>
  let dbFrom: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    savedWebhookUrls.length = 0
    process.env.OPENWA_WEBHOOK_URL = 'https://wacrm.example.com/api/whatsapp/openwa/webhook'
    session = { session_id: 'gateway-session-1' }
    configure = vi.fn().mockResolvedValue(undefined)
    lookupFilters = []
    const lookup = {
      eq: (key: string, value: unknown) => { lookupFilters.push([key, value]); return lookup },
      is: (key: string, value: unknown) => { lookupFilters.push([key, value]); return lookup },
      maybeSingle: async () => ({ data: session, error: null }),
    }
    const write = {
      eq: () => write,
      select: () => write,
      maybeSingle: async () => ({ data: { connection_id: CONNECTION }, error: null }),
    }
    dbFrom = vi.fn((table: string) => table === 'whatsapp_connection_credentials'
      ? { update: (values: { webhook_url?: string }) => {
        if (values.webhook_url) savedWebhookUrls.push(values.webhook_url)
        return write
      } }
      : { select: () => lookup })
    h.auth.mockResolvedValue({
      accountId: ACCOUNT, user: { id: ACTOR }, adminDb: { from: dbFrom },
    })
    h.credentials.mockResolvedValue({
      credentials: { webhookSecret: 'existing-server-only-secret' },
      client: { configureWebhook: configure },
    })
  })

  afterEach(() => {
    if (previousUrl === undefined) delete process.env.OPENWA_WEBHOOK_URL
    else process.env.OPENWA_WEBHOOK_URL = previousUrl
    if (previousProject === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousProject
  })

  it('rejects absent URL with HTTP 400 and no credential or gateway side effects', async () => {
    delete process.env.OPENWA_WEBHOOK_URL
    const response = await POST(request('configure_webhook'), context())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'invalid_request', stage: 'credentials' })
    expect(configure).not.toHaveBeenCalled()
    expect(savedWebhookUrls).toHaveLength(0)
  })

  it('rejects wrong WACRM URL path before secret persistence', async () => {
    process.env.OPENWA_WEBHOOK_URL = 'https://wacrm.example.com/incorrect/webhook'
    const response = await POST(request('configure_webhook'), context())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'invalid_request', stage: 'credentials' })
    expect(configure).not.toHaveBeenCalled()
    expect(savedWebhookUrls).toHaveLength(0)
  })

  it('reports upstream webhook list rejection without a misleading WACRM route 404', async () => {
    configure.mockRejectedValue(new WhatsAppTransportError('invalid_request', 'OpenWA webhook list failed: OpenWA request rejected (404)'))
    const response = await POST(request('configure_webhook'), context())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'invalid_request', stage: 'gateway_registration' })
    expect(configure).toHaveBeenCalledWith('gateway-session-1', process.env.OPENWA_WEBHOOK_URL, 'existing-server-only-secret', CONNECTION)
    expect(lookupFilters).toContainEqual(['account_id', ACCOUNT])
    expect(lookupFilters).toContainEqual(['archived_at', null])
  })

  it('returns an actual 404 only for a missing tenant session', async () => {
    session = null
    const response = await POST(request('configure_webhook'), context())
    expect(response.status).toBe(404)
    expect((await response.json()).code).toBe('not_found')
    expect(h.credentials).not.toHaveBeenCalled()
  })

  it('blocks webhook registration for an unresolved missing session ID', async () => {
    session = { session_id: null }
    const response = await POST(request('configure_webhook'), context())
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('connection_restricted')
    expect(h.credentials).not.toHaveBeenCalled()
  })

  it('enables the signed webhook using a previously persisted secret', async () => {
    const response = await POST(request('configure_webhook'), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      enabled: true, synced: true, webhook_url: process.env.OPENWA_WEBHOOK_URL,
    })
    expect(configure).toHaveBeenCalledTimes(1)
    expect(h.credentials).toHaveBeenCalledTimes(1)
  })

  it('updates one TEST session webhook in OpenWA and persists only the verified URL', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://pqirsnfupofhulmewakq.supabase.co'
    const next = 'https://new-wacrm.example.com/api/whatsapp/openwa/webhook'
    const response = await POST(new Request('https://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'configure_webhook', webhook_url: next }),
    }), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ synced: true, webhook_url: next })
    expect(configure).toHaveBeenCalledWith('gateway-session-1', next, 'existing-server-only-secret', CONNECTION)
    expect(savedWebhookUrls).toEqual([next])
    expect(lookupFilters).toContainEqual(['account_id', ACCOUNT])
    expect(dbFrom).toHaveBeenCalledWith('whatsapp_connection_credentials')
  })

  it('cannot redirect production callbacks through per-session settings', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://production.supabase.co'
    const response = await POST(new Request('https://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'configure_webhook', webhook_url: 'https://unauthorized.example.com/api/whatsapp/openwa/webhook',
      }),
    }), context())
    expect(response.status).toBe(409)
    expect(configure).not.toHaveBeenCalled()
    expect(dbFrom).not.toHaveBeenCalled()
    expect(savedWebhookUrls).toHaveLength(0)
  })

  it('does not store a webhook URL if OpenWA rejects the update', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://pqirsnfupofhulmewakq.supabase.co'
    configure.mockRejectedValue(new WhatsAppTransportError('connection_restricted', 'duplicate callbacks'))
    const response = await POST(new Request('https://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'configure_webhook', webhook_url: 'https://new-wacrm.example.com/api/whatsapp/openwa/webhook',
      }),
    }), context())
    expect(response.status).toBe(409)
    expect((await response.json()).stage).toBe('gateway_registration')
    expect(savedWebhookUrls).toHaveLength(0)
  })

  it('rejects invalid custom webhook URLs before loading session credentials', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://pqirsnfupofhulmewakq.supabase.co'
    const response = await POST(new Request('https://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'configure_webhook', webhook_url: 'https://attacker.example.com/unrelated' }),
    }), context())
    expect(response.status).toBe(400)
    expect(dbFrom).not.toHaveBeenCalled()
    expect(configure).not.toHaveBeenCalled()
  })

  it('prefers the verified per-connection webhook over stale deployment env', async () => {
    h.credentials.mockResolvedValueOnce({
      credentials: { webhookSecret: 'existing-server-only-secret',
        webhookUrl: 'https://saved.example.com/api/whatsapp/openwa/webhook' },
      client: { configureWebhook: configure },
    })
    const response = await POST(request('configure_webhook'), context())
    expect(response.status).toBe(200)
    expect(configure).toHaveBeenCalledWith('gateway-session-1',
      'https://saved.example.com/api/whatsapp/openwa/webhook', 'existing-server-only-secret', CONNECTION)
    expect(savedWebhookUrls).toHaveLength(0)
  })
})

describe('OW-13 tenant-scoped admin pause/resume stop control', () => {
  const filters: Array<[string, unknown]> = []
  let existing: { id: string } | null
  let guardrailUpsert: ReturnType<typeof vi.fn>
  let auditInsert: ReturnType<typeof vi.fn>
  let dbFrom: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    filters.length = 0
    existing = { id: CONNECTION }
    guardrailUpsert = vi.fn().mockResolvedValue({ error: null })
    auditInsert = vi.fn().mockResolvedValue({ error: null })
    const lookup: Record<string, unknown> = {
      select: () => lookup,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return lookup },
      maybeSingle: async () => ({ data: existing, error: null }),
    }
    dbFrom = vi.fn((table: string) => {
      if (table === 'whatsapp_connections') return lookup
      if (table === 'whatsapp_connection_guardrails') return { upsert: guardrailUpsert }
      if (table === 'whatsapp_guardrail_events') return { insert: auditInsert }
      throw new Error('Unexpected table in admin pause simulation')
    })
    h.auth.mockResolvedValue({ accountId: ACCOUNT, user: { id: ACTOR }, adminDb: { from: dbFrom } })
  })

  it.each([
    ['pause', true, 'paused'],
    ['resume', false, 'resumed'],
  ])('updates stop state with admin scope for %s', async (actionName, paused, decision) => {
    const response = await POST(request(actionName), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ connectionId: CONNECTION, manualPaused: paused })
    expect(filters).toContainEqual(['id', CONNECTION])
    expect(filters).toContainEqual(['account_id', ACCOUNT])
    expect(filters).toContainEqual(['provider', 'openwa'])
    expect(guardrailUpsert).toHaveBeenCalledWith(expect.objectContaining({
      account_id: ACCOUNT, connection_id: CONNECTION, manual_paused: paused,
    }), { onConflict: 'connection_id' })
    expect(auditInsert).toHaveBeenCalledWith(expect.objectContaining({
      account_id: ACCOUNT, connection_id: CONNECTION,
      workload: 'manual', decision, reason: 'admin_emergency_control',
    }))
    expect(h.logout).not.toHaveBeenCalled()
  })

  it('blocks generic resume of every TEST DEV pilot connection; use validated pilot controls', async () => {
    const previous = process.env.NEXT_PUBLIC_SUPABASE_URL
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://pqirsnfupofhulmewakq.supabase.co'
    try {
      const response = await POST(request('resume'), context(CONNECTION))
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: 'pilot_control_required' })
      expect(guardrailUpsert).not.toHaveBeenCalled()
      expect(auditInsert).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previous
    }
  })

  it('rejects a connection absent from the authorized tenant without side effects', async () => {
    existing = null
    const response = await POST(request('pause'), context())
    expect(response.status).toBe(400)
    expect(guardrailUpsert).not.toHaveBeenCalled()
    expect(auditInsert).not.toHaveBeenCalled()
  })

  it('never mutates the protected guardrails when admin authentication fails', async () => {
    h.auth.mockRejectedValue(new Error('private session'))
    const response = await POST(request('pause'), context())
    expect(response.status).toBe(502)
    expect(dbFrom).not.toHaveBeenCalled()
    expect(guardrailUpsert).not.toHaveBeenCalled()
  })

  it('returns an explicit error when the stop audit cannot be persisted', async () => {
    auditInsert.mockResolvedValue({ error: { code: '23503', message: 'sensitive internal details' } })
    const response = await POST(request('pause'), context())
    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.code).toBe('retryable_provider_failure')
    expect(body.error).toContain('audit record')
    expect(JSON.stringify(body)).not.toContain('sensitive internal details')
  })
})
