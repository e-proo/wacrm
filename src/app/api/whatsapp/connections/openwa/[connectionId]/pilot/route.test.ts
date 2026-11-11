import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  envMode: { enabled: true },
  connection: { id: '2dacee52-3486-4b47-96a0-fa4399ac0fb2', status: 'ready',
    session_id: 'session-1', phone_identity: '123456789', archived_at: null as string | null },
  guard: { manual_paused: true, hourly_cap: 3, daily_cap: 10, first_touch_daily_cap: 1,
    minimum_interval_ms: 15000, jitter_ms: 3000, warmup_hourly_cap: 3, warmup_daily_cap: 10 },
  active: 0,
  pending: 0,
  duplicates: 1,
  calls: [] as { table: string; type: string; payload: unknown }[],
}))

vi.mock('@/lib/whatsapp/transport/openwa/session-auth', () => ({
  requireOpenWASessionAdmin: h.auth,
}))
vi.mock('@/lib/whatsapp/transport/guardrails', () => ({
  openWAPilotEnforcementEnabled: () => h.envMode.enabled,
  canonicalOpenWAPilotRecipient: (value: string) => /^[1-9][0-9]{6,14}$/.test(value) ? value + '@c.us' : null,
  openWAPilotRecipientHash: () => 'a'.repeat(64),
}))
import { GET, POST } from './route'

const ACCOUNT = '8ed95309-96cd-4347-b725-bd8c5039ed4f'
const CONNECTION = '2dacee52-3486-4b47-96a0-fa4399ac0fb2'
const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const TEST_URL = 'https://pqirsnfupofhulmewakq.supabase.co'
const PREV_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
function context(connectionId = CONNECTION) {
  return { params: Promise.resolve({ connectionId }) }
}
function request(body: unknown) {
  return new Request('http://localhost/api/whatsapp/connections/openwa/test/pilot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function dbFrom(table: string) {
  let operation = 'select'
  const q = {
    select: (_fields?: string, _options?: unknown) => q,
    eq: (_key: string, _value: unknown) => q,
    is: (_key: string, _value: unknown) => q,
    gt: (_key: string, _value: unknown) => q,
    in: (_key: string, _value: unknown) => q,
    maybeSingle: async () => {
      if (operation === 'update') return { data: { connection_id: CONNECTION }, error: null }
      if (table === 'whatsapp_connections') return { data: h.connection, error: null }
      if (table === 'whatsapp_connection_guardrails') return { data: h.guard, error: null }
      return { data: null, error: null }
    },
    update: (payload: Record<string, unknown>) => {
      operation = 'update'
      h.calls.push({ table, type: 'update', payload })
      if (table === 'whatsapp_connection_guardrails') Object.assign(h.guard, payload)
      if (table === 'whatsapp_openwa_pilot_allowlist') h.active = 0
      return q
    },
    upsert: async (payload: Record<string, unknown>) => {
      h.calls.push({ table, type: 'upsert', payload })
      h.active = 1
      return { error: null }
    },
    insert: async (payload: Record<string, unknown>) => {
      h.calls.push({ table, type: 'insert', payload })
      return { error: null }
    },
    then: (resolve: (value: unknown) => unknown) => {
      const count = table === 'whatsapp_openwa_pilot_allowlist' ? h.active
        : table === 'whatsapp_connections' ? h.duplicates : h.pending
      return Promise.resolve(resolve({ data: null, count, error: null }))
    },
  }
  return q
}

describe('OW-13 DEV pilot protected UI API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.calls.length = 0
    h.connection.status = 'ready'
    h.connection.archived_at = null
    Object.assign(h.guard, { manual_paused: true, hourly_cap: 3, daily_cap: 10,
      first_touch_daily_cap: 1, minimum_interval_ms: 15000, jitter_ms: 3000,
      warmup_hourly_cap: 3, warmup_daily_cap: 10 })
    h.active = 0
    h.pending = 0
    h.duplicates = 1
    h.envMode.enabled = true
    process.env.NEXT_PUBLIC_SUPABASE_URL = TEST_URL
    h.auth.mockResolvedValue({ accountId: ACCOUNT, user: { id: USER },
      adminDb: { from: vi.fn(dbFrom) } })
  })
  afterEach(() => {
    if (PREV_URL === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = PREV_URL
  })

  it('refuses non-admin requests before touching the database', async () => {
    h.auth.mockRejectedValue(new WhatsAppTransportError('authentication_or_configuration','denied'))
    const response = await POST(request({ action: 'stop' }), context())
    expect(response.status).toBe(403)
    expect(h.calls).toEqual([])
  })
  it('refuses any Production URL, wrong account or other connection', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://production-project.supabase.co'
    expect((await POST(request({ action: 'stop' }), context())).status).toBe(409)
    process.env.NEXT_PUBLIC_SUPABASE_URL = TEST_URL
    expect((await POST(request({ action: 'stop' }), context('11111111-2222-4333-8444-555555555555'))).status).toBe(409)
    h.auth.mockResolvedValue({ accountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', user: { id: USER }, adminDb: { from: vi.fn(dbFrom) } })
    expect((await POST(request({ action: 'stop' }), context())).status).toBe(409)
    expect(h.calls).toEqual([])
  })
  it('returns admin-only safe state without recipient identities or secrets', async () => {
    const response = await GET(new Request('http://localhost'), context())
    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(payload).toMatchObject({ paused: true, enforced: true, active_admissions: 0,
      unsettled_outbound: 0, guardrails: { hourly_cap: 3, daily_cap: 10 } })
    expect(JSON.stringify(payload)).not.toContain('recipient_hash')
    expect(JSON.stringify(payload)).not.toContain('api_key')
  })
  it('rejects invalid higher pilot caps without changes', async () => {
    const response = await POST(request({
      action: 'limits', hourly_cap: 60, daily_cap: 500,
      first_touch_daily_cap: 1, minimum_interval_ms: 15000, jitter_ms: 0,
    }), context())
    expect(response.status).toBe(400)
    expect(h.calls).toEqual([])
  })
  it('saves tightly capped settings only while paused', async () => {
    const response = await POST(request({ action: 'limits', hourly_cap: 2, daily_cap: 6,
      first_touch_daily_cap: 1, minimum_interval_ms: 20000, jitter_ms: 1500 }), context())
    expect(response.status).toBe(200)
    expect(h.guard.hourly_cap).toBe(2)
    expect(h.calls).toContainEqual(expect.objectContaining({
      table: 'whatsapp_connection_guardrails', type: 'update',
      payload: expect.objectContaining({ hourly_cap: 2, daily_cap: 6, warmup_hourly_cap: 2 }),
    }))
  })
  it('does not grant a recipient without explicit consent or enforce mode', async () => {
    expect((await POST(request({ action: 'grant', recipient: '12345678901', consent_confirmed: false }), context())).status).toBe(400)
    h.envMode.enabled = false
    expect((await POST(request({ action: 'grant', recipient: '12345678901', consent_confirmed: true }), context())).status).toBe(409)
    expect(h.calls).toEqual([])
  })
  it('requires review of duplicate identity before granting', async () => {
    h.duplicates = 5
    const response = await POST(request({ action: 'grant', recipient: '12345678901', consent_confirmed: true }), context())
    expect(response.status).toBe(409)
    expect(h.calls).toEqual([])
  })
  it('grants only a hashed manual recipient for four hours and stays paused', async () => {
    const response = await POST(request({ action: 'grant', recipient: '12345678901',
      consent_confirmed: true, ack_duplicate_sessions: true, hours: 4 }), context())
    expect(response.status).toBe(200)
    expect(h.guard.manual_paused).toBe(true)
    expect(h.calls).toContainEqual(expect.objectContaining({
      table: 'whatsapp_openwa_pilot_allowlist', type: 'upsert',
      payload: expect.objectContaining({ recipient_hash: 'a'.repeat(64), active: true,
        workload: 'manual', approved_by: USER }),
    }))
    expect(JSON.stringify(h.calls)).not.toContain('12345678901')
  })
  it('does not activate with no grant or unresolved sends', async () => {
    expect((await POST(request({ action: 'activate' }), context())).status).toBe(409)
    h.active = 1; h.pending = 2
    expect((await POST(request({ action: 'activate' }), context())).status).toBe(409)
    expect(h.calls).toEqual([])
  })
  it('activates a fully qualified paused connection and audits the operation', async () => {
    h.active = 1
    const response = await POST(request({ action: 'activate' }), context())
    expect(response.status).toBe(200)
    expect((await response.json()).active).toBe(true)
    expect(h.guard.manual_paused).toBe(false)
    expect(h.calls).toContainEqual(expect.objectContaining({
      table: 'whatsapp_guardrail_events', type: 'insert',
      payload: expect.objectContaining({ decision: 'resumed', reason: 'ow13_dev_pilot_admin_activate' }),
    }))
  })
  it('stops independently of the runtime enforcement flag, revokes grants and audits', async () => {
    h.envMode.enabled = false
    h.guard.manual_paused = false
    h.active = 1
    const response = await POST(request({ action: 'stop' }), context())
    expect(response.status).toBe(200)
    expect(h.guard.manual_paused).toBe(true)
    expect(h.active).toBe(0)
    expect(h.calls).toContainEqual(expect.objectContaining({
      table: 'whatsapp_guardrail_events', type: 'insert',
      payload: expect.objectContaining({ decision: 'paused', reason: 'ow13_dev_pilot_admin_stop' }),
    }))
  })
})
