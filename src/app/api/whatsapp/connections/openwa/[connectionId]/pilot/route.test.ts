import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  refresh: vi.fn(),
  resolveRecipient: vi.fn(),
  recipientHash: vi.fn((_account: string, _connection: string, _recipient: string) => 'a'.repeat(64)),
  envMode: { enabled: true, invalid: false },
  connection: { id: '2dacee52-3486-4b47-96a0-fa4399ac0fb2', status: 'ready',
    session_id: 'session-1' as string | null, phone_identity: '123456789', archived_at: null as string | null },
  guard: { pilot_enabled: true, manual_paused: true, hourly_cap: 3, daily_cap: 10, first_touch_daily_cap: 1,
    minimum_interval_ms: 15000, jitter_ms: 3000, warmup_hourly_cap: 3, warmup_daily_cap: 10 },
  active: 0,
  grantWorkload: 'manual' as 'manual' | 'agent',
  recentInbound: true,
  inboundInTenant: true,
  guardConfigured: true,
  pending: 0,
  duplicates: 1,
  calls: [] as { table: string; type: string; payload: unknown }[],
}))

vi.mock('@/lib/whatsapp/transport/openwa/session-auth', () => ({
  requireOpenWASessionAdmin: h.auth,
}))
vi.mock('@/lib/whatsapp/transport/openwa/session-lifecycle', () => ({
  refreshOpenWAConnectionStatus: h.refresh,
}))
vi.mock('@/lib/whatsapp/transport/openwa/pilot-recipient', () => ({
  resolveOpenWAPilotRecipientForGrant: h.resolveRecipient,
}))
vi.mock('@/lib/whatsapp/transport/guardrails', () => ({
  isOpenWATestProject: () => process.env.NEXT_PUBLIC_SUPABASE_URL === 'https://pqirsnfupofhulmewakq.supabase.co',
  openWAPilotEnforcementEnabled: () => { if (h.envMode.invalid) throw new Error('invalid mode'); return h.envMode.enabled },
  canonicalOpenWAPilotRecipient: (value: string) => /^[1-9][0-9]{6,14}$/.test(value)
    ? value + '@c.us' : /^[0-9]{5,20}@lid$/.test(value) ? value : null,
  openWAPilotRecipientHash: h.recipientHash,
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
  const filters: Record<string, unknown> = {}
  const q = {
    select: (_fields?: string, _options?: unknown) => q,
    eq: (key: string, value: unknown) => { filters[key] = value; return q },
    is: (_key: string, _value: unknown) => q,
    gt: (_key: string, _value: unknown) => q,
    gte: (_key: string, _value: unknown) => q,
    order: (_key: string, _options?: unknown) => q,
    limit: (_n: number) => q,
    in: (_key: string, _value: unknown) => q,
    maybeSingle: async () => {
      if (operation === 'update') return { data: { connection_id: CONNECTION }, error: null }
      if (table === 'whatsapp_connections') return { data:
        filters.id === h.connection.id && filters.account_id === ACCOUNT && filters.provider === 'openwa'
          ? h.connection : null, error: null }
      if (table === 'whatsapp_connection_guardrails') return { data: h.guardConfigured ? h.guard : null, error: null }
      if (table === 'messages') return {
        data: h.recentInbound ? { conversation_id: 'verified-test-conversation' } : null, error: null,
      }
      if (table === 'conversations') return {
        data: h.inboundInTenant && filters.account_id === ACCOUNT
          ? { id: 'verified-test-conversation' } : null, error: null,
      }
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
      if (table === 'whatsapp_openwa_pilot_allowlist') {
        const first = Array.isArray(payload) ? payload[0] : payload
        h.active = Array.isArray(payload) ? payload.length : 1
        h.grantWorkload = first.workload === 'agent' ? 'agent' : 'manual'
      }
      if (table === 'whatsapp_connection_guardrails') {
        h.guardConfigured = true
        Object.assign(h.guard, payload)
      }
      return { error: null }
    },
    insert: async (payload: Record<string, unknown>) => {
      h.calls.push({ table, type: 'insert', payload })
      return { error: null }
    },
    then: (resolve: (value: unknown) => unknown) => {
      const count = table === 'whatsapp_openwa_pilot_allowlist'
        ? (filters.workload && filters.workload !== h.grantWorkload ? 0 : h.active)
        : table === 'whatsapp_connections' ? h.duplicates : h.pending
      return Promise.resolve(resolve({ data: null, count, error: null }))
    },
  }
  return q
}

describe('OW-13 DEV pilot protected UI API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.recipientHash.mockImplementation(() => 'a'.repeat(64))
    h.calls.length = 0
    h.connection.id = CONNECTION
    h.connection.status = 'ready'
    h.connection.session_id = 'session-1'
    h.connection.archived_at = null
    Object.assign(h.guard, { pilot_enabled: true, manual_paused: true, hourly_cap: 3, daily_cap: 10,
      first_touch_daily_cap: 1, minimum_interval_ms: 15000, jitter_ms: 3000,
      warmup_hourly_cap: 3, warmup_daily_cap: 10,
      pilot_agent_hourly_cap: undefined, pilot_agent_daily_cap: undefined,
      pilot_manual_hourly_cap: undefined, pilot_manual_daily_cap: undefined })
    h.active = 0
    h.grantWorkload = 'manual'
    h.recentInbound = true
    h.inboundInTenant = true
    h.guardConfigured = true
    h.pending = 0
    h.duplicates = 1
    h.envMode.enabled = true
    h.envMode.invalid = false
    h.refresh.mockResolvedValue({ status: 'ready', phoneIdentity: '123456789' })
    h.resolveRecipient.mockResolvedValue({ recipient: '12345678901@c.us', source: 'phone_without_inbound' })
    process.env.NEXT_PUBLIC_SUPABASE_URL = TEST_URL
    h.auth.mockResolvedValue({ accountId: ACCOUNT, user: { id: USER },
      adminDb: { from: vi.fn(dbFrom), rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name !== 'set_openwa_test_pilot_mode') return { data: null, error: { code: 'unknown' } }
        h.calls.push({ table: 'set_openwa_test_pilot_mode', type: 'rpc', payload: args })
        h.guard.pilot_enabled = args.p_pilot_enabled === true
        h.guard.manual_paused = h.guard.pilot_enabled
        h.active = 0
        return { data: { updated: true }, error: null }
      }) } })
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
  it('refuses a Production URL, wrong tenant, or missing connection', async () => {
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
    expect(payload).toMatchObject({ configured: true, paused: true, enforced: true, active_admissions: 0,
      unsettled_outbound: 0, guardrails: { hourly_cap: 3, daily_cap: 10 } })
    expect(JSON.stringify(payload)).not.toContain('recipient_hash')
    expect(JSON.stringify(payload)).not.toContain('api_key')
  })
  it('shows unconfigured fresh sessions without writing permissive limits', async () => {
    h.connection.id = '02527740-9806-45ae-b9b1-1354c25f1d3f'
    h.guardConfigured = false
    const response = await GET(new Request('http://localhost'), context(h.connection.id))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      connectionId: h.connection.id, configured: false, paused: true, active: false,
      guardrails: { hourly_cap: 3, daily_cap: 10 },
    })
    expect(h.calls).toEqual([])
    h.connection.id = CONNECTION
  })

  it('prepares the newly selected TEST session with strict paused caps and no grant', async () => {
    h.connection.id = '02527740-9806-45ae-b9b1-1354c25f1d3f'
    h.guardConfigured = false
    const response = await POST(request({ action: 'prepare', confirm_prepare: true }),
      context(h.connection.id))
    expect(response.status).toBe(200)
    expect((await response.json()).configured).toBe(true)
    expect(h.guard.manual_paused).toBe(true)
    expect(h.calls).toContainEqual(expect.objectContaining({
      table: 'whatsapp_connection_guardrails', type: 'upsert',
      payload: expect.objectContaining({
        account_id: ACCOUNT, connection_id: h.connection.id,
        manual_paused: true, hourly_cap: 3, daily_cap: 10,
        first_touch_daily_cap: 1, minimum_interval_ms: 15000,
      }),
    }))
    expect(h.calls.filter((c) => c.table === 'whatsapp_openwa_pilot_allowlist')).toHaveLength(0)
    h.connection.id = CONNECTION
  })

  it('cannot prepare an unknown session, one with unsettled messages, or without confirmation', async () => {
    expect((await POST(request({ action: 'prepare', confirm_prepare: true }),
      context('22222222-2222-4222-8222-222222222222'))).status).toBe(409)
    expect((await POST(request({ action: 'prepare' }), context())).status).toBe(400)
    h.pending = 1
    expect((await POST(request({ action: 'prepare', confirm_prepare: true }), context())).status).toBe(409)
    expect(h.calls).toEqual([])
  })

  it('rejects values above 100/hour and 1000/day, or an excessive first-touch cap', async () => {
    for (const invalid of [
      { hourly_cap: 101, daily_cap: 1000, first_touch_daily_cap: 10 },
      { hourly_cap: 100, daily_cap: 1001, first_touch_daily_cap: 10 },
      { hourly_cap: 100, daily_cap: 1000, first_touch_daily_cap: 11 },
    ]) {
      const response = await POST(request({
        action: 'limits', ...invalid,
        minimum_interval_ms: 15000, jitter_ms: 0,
      }), context())
      expect(response.status).toBe(400)
    }
    expect(h.calls).toEqual([])
  })

  it('accepts 100/hour and 1000/day on paused TEST with explicit bounded workload caps', async () => {
    const response = await POST(request({
      action: 'limits',
      hourly_cap: 100, daily_cap: 1000, first_touch_daily_cap: 10,
      minimum_interval_ms: 15000, jitter_ms: 3000,
      pilot_agent_hourly_cap: 100, pilot_agent_daily_cap: 1000,
      pilot_manual_hourly_cap: 100, pilot_manual_daily_cap: 1000,
    }), context())
    expect(response.status).toBe(200)
    expect(h.calls).toContainEqual(expect.objectContaining({
      table: 'whatsapp_connection_guardrails', type: 'update',
      payload: expect.objectContaining({
        hourly_cap: 100, daily_cap: 1000,
        pilot_agent_hourly_cap: 100, pilot_agent_daily_cap: 1000,
        pilot_manual_hourly_cap: 100, pilot_manual_daily_cap: 1000,
        first_touch_daily_cap: 10,
        warmup_hourly_cap: 100, warmup_daily_cap: 1000,
        manual_paused: undefined,
      }),
    }))
    expect(h.guard.manual_paused).toBe(true)
    expect(h.active).toBe(0)
  })

  it('refuses workload caps higher than shared per-session caps', async () => {
    const response = await POST(request({
      action: 'limits', hourly_cap: 20, daily_cap: 200,
      first_touch_daily_cap: 3, minimum_interval_ms: 15000, jitter_ms: 1000,
      pilot_agent_hourly_cap: 100, pilot_agent_daily_cap: 1000,
      pilot_manual_hourly_cap: 20, pilot_manual_daily_cap: 200,
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
  it('grants the native inbound LID, not the guessed phone JID, on the exact TEST session', async () => {
    const nativeLid = '123456789012345@lid'
    h.resolveRecipient.mockResolvedValue({
      recipient: nativeLid, source: 'verified_inbound_chat',
    })
    const response = await POST(request({
      action: 'grant', recipient: '12345678901',
      consent_confirmed: true, ack_duplicate_sessions: true, hours: 4,
    }), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      recipient_identity_source: 'verified_inbound_chat',
    })
    expect(h.resolveRecipient).toHaveBeenCalledWith(expect.anything(), ACCOUNT, CONNECTION, '12345678901')
    expect(h.recipientHash).toHaveBeenCalledWith(ACCOUNT, CONNECTION, nativeLid)
    expect(JSON.stringify(h.calls)).not.toContain(nativeLid)
    expect(JSON.stringify(h.calls)).not.toContain('12345678901')
  })
  it('denies Agent Task grants until explicitly confirmed and capped to one message', async () => {
    h.resolveRecipient.mockResolvedValue({ recipient: '12345678901@c.us', source: 'verified_inbound_chat' })
    expect((await POST(request({
      action: 'grant_agent', recipient: '12345678901', consent_confirmed: true,
    }), context())).status).toBe(400)
    expect((await POST(request({
      action: 'grant_agent', recipient: '12345678901', consent_confirmed: true,
      confirm_agent_task_test: true,
    }), context())).status).toBe(409)
    expect(h.calls).toEqual([])
  })

  it('does not approve an Agent Task recipient without a verified inbound chat mapping', async () => {
    Object.assign(h.guard, { hourly_cap: 1, daily_cap: 1,
      warmup_hourly_cap: 1, warmup_daily_cap: 1 })
    h.resolveRecipient.mockResolvedValue({
      recipient: '12345678901@c.us', source: 'phone_without_inbound',
    })
    expect((await POST(request({
      action: 'grant_agent', recipient: '12345678901',
      consent_confirmed: true, confirm_agent_task_test: true,
    }), context())).status).toBe(409)
    expect(h.calls).toEqual([])
  })

  it('requires a fresh inbound from the exact TEST chat and tenant for Agent Task grant', async () => {
    Object.assign(h.guard, { hourly_cap: 1, daily_cap: 1,
      warmup_hourly_cap: 1, warmup_daily_cap: 1 })
    h.resolveRecipient.mockResolvedValue({
      recipient: '12345678901@c.us', source: 'verified_inbound_chat',
    })
    h.recentInbound = false
    expect((await POST(request({
      action: 'grant_agent', recipient: '12345678901',
      consent_confirmed: true, confirm_agent_task_test: true,
    }), context())).status).toBe(409)
    expect(h.calls).toEqual([])
    h.recentInbound = true
    h.inboundInTenant = false
    expect((await POST(request({
      action: 'grant_agent', recipient: '12345678901',
      consent_confirmed: true, confirm_agent_task_test: true,
    }), context())).status).toBe(409)
    expect(h.calls).toEqual([])
  })

  it('refuses a bare native @lid for telephone consent even with an attestation', async () => {
    Object.assign(h.guard, {
      hourly_cap: 1, daily_cap: 1, first_touch_daily_cap: 1,
      warmup_hourly_cap: 1, warmup_daily_cap: 1,
    })
    h.resolveRecipient.mockResolvedValue({
      recipient: '1234567890123@lid', source: 'direct_recipient',
    })
    const result = await POST(request({
      action: 'grant_agent', recipient: '1234567890123@lid',
      consent_confirmed: true, confirm_agent_task_test: true,
      consent_basis: 'phone_call', phone_call_opt_in_confirmed: true,
    }), context())
    expect(result.status).toBe(400)
    expect(h.calls).toEqual([])
  })

  it('grants single Agent TEST first-touch only after explicit phone-call WhatsApp opt-in', async () => {
    Object.assign(h.guard, {
      hourly_cap: 1, daily_cap: 1, first_touch_daily_cap: 1,
      warmup_hourly_cap: 1, warmup_daily_cap: 1,
    })
    h.recentInbound = false
    h.resolveRecipient.mockResolvedValue({
      recipient: '12345678901@c.us', source: 'phone_without_inbound',
    })
    const result = await POST(request({
      action: 'grant_agent', recipient: '12345678901',
      consent_confirmed: true, confirm_agent_task_test: true,
      consent_basis: 'phone_call', phone_call_opt_in_confirmed: true,
      hours: 1,
    }), context())
    expect(result.status).toBe(200)
    expect(h.calls).toContainEqual(expect.objectContaining({
      table: 'whatsapp_openwa_pilot_allowlist',
      type: 'upsert',
      payload: expect.objectContaining({
        workload: 'agent',
        consent_basis: 'phone_call',
        consent_attested_at: expect.any(String),
      }),
    }))
    expect(h.calls.some(call => call.table === 'contacts')).toBe(false)
    expect(h.calls.some(call => call.table === 'messages')).toBe(false)
  })

  it('grants only Agent Task workload for verified TEST inbound and activates with strict caps', async () => {
    Object.assign(h.guard, { hourly_cap: 1, daily_cap: 1,
      warmup_hourly_cap: 1, warmup_daily_cap: 1 })
    h.resolveRecipient.mockResolvedValue({
      recipient: '12345678901@c.us', source: 'verified_inbound_chat',
    })
    const res = await POST(request({
      action: 'grant_agent', recipient: '12345678901', consent_confirmed: true,
      confirm_agent_task_test: true, hours: 1,
    }), context())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      approved_workload: 'agent', active_admissions: 1, paused: true,
    })
    expect(h.calls).toContainEqual(expect.objectContaining({
      table: 'whatsapp_openwa_pilot_allowlist', type: 'upsert',
      payload: expect.objectContaining({
        recipient_hash: 'a'.repeat(64), workload: 'agent', active: true, approved_by: USER,
      }),
    }))
    expect(JSON.stringify(h.calls)).not.toContain('12345678901')
    const started = await POST(request({ action: 'activate' }), context())
    expect(started.status).toBe(200)
    expect(await started.json()).toMatchObject({ active: true, approved_workload: 'agent' })
    expect(h.calls).toContainEqual(expect.objectContaining({
      table: 'whatsapp_guardrail_events', type: 'insert',
      payload: expect.objectContaining({ workload: 'agent', decision: 'resumed' }),
    }))
  })

  it('requires active Agent grant count to fit bounded safe caps', async () => {
    h.active = 2
    h.grantWorkload = 'agent'
    expect((await POST(request({ action: 'activate' }), context())).status).toBe(409)
    expect(h.calls).toEqual([])
  })

  it('approves two separate, consenting Agent recipients atomically in TEST and activates only their workload', async () => {
    Object.assign(h.guard, { hourly_cap: 3, daily_cap: 10,
      first_touch_daily_cap: 2, warmup_hourly_cap: 3, warmup_daily_cap: 10 })
    h.resolveRecipient.mockImplementation(async (_db: unknown, _a: string, _c: string, value: string) => ({
      recipient: value + '@c.us', source: 'verified_inbound_chat',
    }))
    h.recipientHash.mockImplementation((_a: string, _c: string, value: string) =>
      value.startsWith('123') ? '1'.repeat(64) : '2'.repeat(64))
    const approved = await POST(request({
      action: 'grant_batch', workload: 'agent',
      recipients: ['12345678901','23456789012'],
      consent_confirmed: true, confirm_agent_task_test: true, hours: 4,
    }), context())
    expect(approved.status).toBe(200)
    expect(await approved.json()).toMatchObject({ approved_count: 2,
      active_admissions: 2, agent_admissions: 2, approved_workload: 'agent' })
    const approvals = h.calls.filter(x => x.table === 'whatsapp_openwa_pilot_allowlist')
    expect(approvals).toHaveLength(1)
    expect(Array.isArray(approvals[0].payload)).toBe(true)
    expect((approvals[0].payload as unknown[])).toHaveLength(2)
    expect(JSON.stringify(approvals)).not.toContain('12345678901')
    const activated = await POST(request({action:'activate'}), context())
    expect(activated.status).toBe(200)
    expect((await activated.json()).active).toBe(true)
  })

  it('explains which bounded TEST caps block three recipients, with no grant or send', async () => {
    h.resolveRecipient.mockImplementation(async (_db: unknown, _a: string, _c: string, raw: string) => ({
      recipient: raw + '@c.us', source: 'phone_without_inbound',
    }))
    const result = await POST(request({
      action: 'grant_batch', workload: 'agent',
      recipients: ['12345678901', '23456789012', '34567890123'],
      consent_confirmed: true, confirm_agent_task_test: true,
      consent_basis: 'phone_call', phone_call_opt_in_confirmed: true,
    }), context())
    expect(result.status).toBe(409)
    expect(await result.json()).toMatchObject({
      code: 'pilot_cohort_caps_insufficient',
      required_count: 3,
      missing_caps: ['first_touch_daily_cap'],
    })
    expect(h.calls).toEqual([])
  })

  it('accepts a three-number Agent cohort only after an explicit bounded limits save', async () => {
    // Existing cap rows can contain workload limits larger than the session.
    Object.assign(h.guard, {
      pilot_agent_hourly_cap: 10, pilot_agent_daily_cap: 30,
      pilot_manual_hourly_cap: 10, pilot_manual_daily_cap: 30,
    })
    const saved = await POST(request({
      action: 'limits',
      hourly_cap: 3, daily_cap: 10, first_touch_daily_cap: 3,
      minimum_interval_ms: 15000, jitter_ms: 3000,
      pilot_agent_hourly_cap: 3, pilot_agent_daily_cap: 10,
      pilot_manual_hourly_cap: 3, pilot_manual_daily_cap: 10,
    }), context())
    expect(saved.status).toBe(200)
    expect(h.guard.first_touch_daily_cap).toBe(3)
    expect(h.guard).toMatchObject({ pilot_agent_hourly_cap: 3 })
    expect(h.guard.warmup_hourly_cap).toBe(3)
    h.resolveRecipient.mockImplementation(async (_db: unknown, _a: string, _c: string, raw: string) => ({
      recipient: raw + '@c.us', source: 'phone_without_inbound',
    }))
    h.recipientHash.mockImplementation((_a: string, _c: string, raw: string) => (
      raw.startsWith('123') ? '1'.repeat(64)
        : raw.startsWith('234') ? '2'.repeat(64) : '3'.repeat(64)
    ))
    const approved = await POST(request({
      action: 'grant_batch', workload: 'agent',
      recipients: ['12345678901', '23456789012', '34567890123'],
      consent_confirmed: true, confirm_agent_task_test: true,
      consent_basis: 'phone_call', phone_call_opt_in_confirmed: true,
    }), context())
    expect(approved.status).toBe(200)
    expect(await approved.json()).toMatchObject({
      approved_count: 3, agent_admissions: 3, paused: true,
    })
    const approval = h.calls.find(call => call.table === 'whatsapp_openwa_pilot_allowlist')
    expect(approval).toBeDefined()
    expect(Array.isArray(approval?.payload)).toBe(true)
    expect(h.guard.manual_paused).toBe(true)
  })

  it('accepts explicit phone-call opt-in for a new Agent number without an inbound chat or CRM contact', async () => {
    Object.assign(h.guard, {first_touch_daily_cap: 2})
    h.recentInbound = false
    h.resolveRecipient.mockImplementation(async (_db: unknown, _a: string, _c: string, raw: string) => ({
      recipient: raw + '@c.us', source: 'phone_without_inbound',
    }))
    h.recipientHash.mockImplementation((_a: string, _c: string, raw: string) =>
      raw.startsWith('123') ? '1'.repeat(64) : '2'.repeat(64))
    const missingEvidence = await POST(request({
      action: 'grant_batch', workload: 'agent',
      recipients: ['12345678901', '23456789012'],
      consent_confirmed: true, confirm_agent_task_test: true,
      consent_basis: 'phone_call',
    }), context())
    expect(missingEvidence.status).toBe(400)
    expect(h.calls).toEqual([])

    const approved = await POST(request({
      action: 'grant_batch', workload: 'agent',
      recipients: ['12345678901', '23456789012'],
      consent_confirmed: true, confirm_agent_task_test: true,
      consent_basis: 'phone_call', phone_call_opt_in_confirmed: true,
    }), context())
    expect(approved.status).toBe(200)
    const approvals = h.calls.filter(call => call.table === 'whatsapp_openwa_pilot_allowlist')
    expect(approvals).toHaveLength(1)
    expect(approvals[0].payload).toEqual(expect.arrayContaining([
      expect.objectContaining({ consent_basis: 'phone_call', consent_attested_at: expect.any(String) }),
    ]))
    expect(JSON.stringify(approvals)).not.toContain('12345678901')
    expect(h.calls.some(call => call.table === 'contacts')).toBe(false)
  })

  it('denies an entire Agent cohort when any chosen chat lacks a verified recent inbound', async () => {
    Object.assign(h.guard, { first_touch_daily_cap: 2 })
    h.resolveRecipient.mockResolvedValueOnce({
      recipient: '12345678901@c.us', source: 'verified_inbound_chat',
    }).mockResolvedValueOnce({
      recipient: '23456789012@c.us', source: 'phone_without_inbound',
    })
    const res = await POST(request({ action:'grant_batch', workload:'agent',
      recipients:['12345678901','23456789012'],
      consent_confirmed:true, confirm_agent_task_test:true }),context())
    expect(res.status).toBe(409)
    expect(h.calls.filter(x => x.table === 'whatsapp_openwa_pilot_allowlist')).toHaveLength(0)
  })

  it('accepts a manually entered consenting number without creating a CRM contact, but never for unverified Agent first touch', async () => {
    h.resolveRecipient.mockResolvedValue({
      recipient:'12345678901@c.us', source:'phone_without_inbound',
    })
    const res = await POST(request({action:'grant_batch',workload:'manual',
      recipients:['12345678901'],consent_confirmed:true}),context())
    expect(res.status).toBe(200)
    expect(h.calls.some(x => x.table === 'whatsapp_openwa_pilot_allowlist')).toBe(true)
    expect(h.calls.some(x => x.table === 'contacts')).toBe(false)
  })

  it('refuses duplicate hashes, unconsented cohorts and over-ten recipients before persisting grants', async () => {
    Object.assign(h.guard, {first_touch_daily_cap: 2})
    for (const options of [
      {recipients:['12345678901','23456789012'],consent_confirmed:false},
      {recipients:Array.from({length:11},(_,i)=>'1234567890'+i),consent_confirmed:true},
    ]) {
      const res = await POST(request({action:'grant_batch',workload:'manual',...options}),context())
      expect(res.status).toBe(400)
    }
    h.resolveRecipient.mockResolvedValue({recipient:'12345678901@c.us',source:'verified_inbound_chat'})
    const duplicate = await POST(request({action:'grant_batch',workload:'manual',
      recipients:['12345678901','23456789012'],consent_confirmed:true}),context())
    expect(duplicate.status).toBe(400)
    expect(h.calls.filter(x=>x.table==='whatsapp_openwa_pilot_allowlist')).toHaveLength(0)
  })

  it('does not persist an approval when native chat identity cannot be resolved safely', async () => {
    h.resolveRecipient.mockRejectedValue(new WhatsAppTransportError(
      'connection_restricted', 'Multiple native identities for this contact',
    ))
    const response = await POST(request({
      action: 'grant', recipient: '12345678901', consent_confirmed: true,
    }), context())
    expect(response.status).toBe(409)
    expect(h.calls).toEqual([])
  })
  it('does not activate with no grant or unresolved sends', async () => {
    expect((await POST(request({ action: 'activate' }), context())).status).toBe(409)
    h.active = 1; h.pending = 2
    expect((await POST(request({ action: 'activate' }), context())).status).toBe(409)
    expect(h.calls).toEqual([])
  })
  it('refuses start if OpenWA gateway no longer reports ready', async () => {
    h.active = 1
    h.refresh.mockResolvedValue({ status: 'disconnected' })
    const response = await POST(request({ action: 'activate' }), context())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'pilot_gateway_not_ready' })
    expect(h.guard.manual_paused).toBe(true)
    expect(h.calls).toEqual([])
  })
  it('keeps the session paused when live gateway verification fails', async () => {
    h.active = 1
    h.refresh.mockRejectedValue(new Error('gateway timed out'))
    const response = await POST(request({ action: 'activate' }), context())
    expect(response.status).toBe(502)
    expect(h.guard.manual_paused).toBe(true)
    expect(h.calls).toEqual([])
  })
  it('activates a fully qualified paused connection and audits the operation', async () => {
    h.active = 1
    const response = await POST(request({ action: 'activate' }), context())
    expect(response.status).toBe(200)
    expect((await response.json()).active).toBe(true)
    expect(h.guard.manual_paused).toBe(false)
    expect(h.refresh).toHaveBeenCalledWith(expect.anything(), ACCOUNT, CONNECTION)
    expect(h.calls).toContainEqual(expect.objectContaining({
      table: 'whatsapp_guardrail_events', type: 'insert',
      payload: expect.objectContaining({ decision: 'resumed', reason: 'ow13_dev_pilot_admin_activate' }),
    }))
  })

  it('can disable Pilot for exactly this TEST session after explicit admin confirmation', async () => {
    expect((await POST(request({ action: 'disable' }), context())).status).toBe(400)
    const response = await POST(request({ action: 'disable', confirm_normal_sending: true }), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ pilot_enabled: false, paused: false, active: false })
    expect(h.calls).toContainEqual(expect.objectContaining({
      table: 'set_openwa_test_pilot_mode', type: 'rpc',
      payload: expect.objectContaining({ p_account_id: ACCOUNT, p_connection_id: CONNECTION,
        p_actor: USER, p_pilot_enabled: false, p_confirm_normal_sending: true }),
    }))
    expect(h.refresh).toHaveBeenCalledWith(expect.anything(), ACCOUNT, CONNECTION)
    expect((await POST(request({ action: 'grant', recipient: '12345678901', consent_confirmed: true }), context())).status).toBe(409)
  })

  it('refuses normal send transition with unsettled messages, duplicate sessions or stale gateway', async () => {
    h.pending = 1
    expect((await POST(request({ action: 'disable', confirm_normal_sending: true }), context())).status).toBe(409)
    h.pending = 0
    h.duplicates = 2
    expect((await POST(request({ action: 'disable', confirm_normal_sending: true }), context())).status).toBe(409)
    h.duplicates = 1
    h.refresh.mockResolvedValue({ status: 'disconnected' })
    expect((await POST(request({ action: 'disable', confirm_normal_sending: true }), context())).status).toBe(409)
    expect(h.calls).toEqual([])
  })

  it('re-enables Pilot with a paused session and no active grants', async () => {
    h.guard.pilot_enabled = false
    h.guard.manual_paused = false
    const response = await POST(request({ action: 'enable' }), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ pilot_enabled: true, paused: true, active: false })
    expect(h.calls).toContainEqual(expect.objectContaining({
      table: 'set_openwa_test_pilot_mode', type: 'rpc',
      payload: expect.objectContaining({ p_pilot_enabled: true }),
    }))
  })

  it('allows STOP after the upstream session ID is lost, without unpausing', async () => {
    h.connection.session_id = null
    h.guard.manual_paused = false
    h.active = 1
    const response = await POST(request({ action: 'stop' }), context())
    expect(response.status).toBe(200)
    expect(h.guard.manual_paused).toBe(true)
    expect(h.active).toBe(0)
    expect((await POST(request({ action: 'activate' }), context())).status).toBe(409)
  })
  it('keeps emergency STOP available even with an invalid runtime flag', async () => {
    h.envMode.invalid = true
    h.guard.manual_paused = false
    h.active = 1
    const response = await POST(request({ action: 'stop' }), context())
    expect(response.status).toBe(200)
    expect(h.guard.manual_paused).toBe(true)
    expect(h.active).toBe(0)
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
