import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  auth: vi.fn(), resolveClient: vi.fn(), upstream: vi.fn(),
}))
vi.mock('@/lib/whatsapp/transport/openwa/session-auth', () => ({
  requireOpenWASessionAdmin: h.auth,
}))
vi.mock('@/lib/whatsapp/transport/openwa/credentials', () => ({
  resolveOpenWAClient: h.resolveClient,
}))
import { GET, POST } from './route'

const CONNECTION = '11111111-2222-4333-8444-555555555555'
const JOB = '99999999-2222-4333-8444-555555555555'
const LID = '123456789012345@lid'
const PHONE = '967700000001'
const ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ENDPOINT = `https://localhost/api/whatsapp/connections/openwa/${CONNECTION}/reconciliation`
const context = { params: Promise.resolve({ connectionId: CONNECTION }) }
function request(body: Record<string, unknown>) {
  return new Request(ENDPOINT, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
function db(options: { hasJob?: boolean; matching?: boolean; ready?: boolean } = {}) {
  const updates: Record<string, unknown>[] = []
  const queries: Array<{ table: string; filters: Record<string, unknown> }> = []
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {}
    let patch: Record<string, unknown> | null = null
    const q = {
      select: () => q,
      eq: (name: string, val: unknown) => { filters[name] = val; return q },
      in: (name: string, values: unknown[]) => { filters[name] = values; return q },
      is: (name: string, val: unknown) => { filters[name] = val; return q },
      order: () => q, limit: () => q,
      update: (values: Record<string, unknown>) => { patch = values; updates.push(values); return q },
      maybeSingle: async () => {
        queries.push({ table, filters: { ...filters } })
        if (table === 'whatsapp_connections') {
          if (patch) return { data: null, error: null }
          return { data: {
            id: CONNECTION, session_id: 'sess', phone_identity: 'linked',
            instance_id: 'instance', status: options.ready === false ? 'disconnected' : 'ready',
          }, error: null }
        }
        if (table === 'openwa_deferred_events' && patch) {
          return { data: { id: JOB }, error: null }
        }
        return { data: options.hasJob === false ? null : {
          id: JOB, native_chat_id: LID, session_id: options.matching === false ? 'other' : 'sess',
          own_phone_identity: 'linked', instance_id: 'instance', event_kind: 'unresolved_identity',
        }, error: null }
      },
      then: (resolve: (v: unknown) => unknown) => resolve({
        data: table === 'openwa_deferred_events' ? [] : null, error: null,
      }),
    }
    return q
  })
  return { from, updates, queries }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://pqirsnfupofhulmewakq.supabase.co')
  h.upstream.mockResolvedValue({ lid: LID })
  h.resolveClient.mockResolvedValue({ client: { request: h.upstream } })
  h.auth.mockResolvedValue({ accountId: ACCOUNT, adminDb: db() })
})

describe('OpenWA deferred reconciliation admin boundary', () => {
  it('rejects production mutation without touching OpenWA', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://other.supabase.co')
    expect((await POST(request({ action: 'verify_phone', job_id: JOB, phone: PHONE }), context)).status).toBe(403)
    expect(h.auth).not.toHaveBeenCalled()
    expect(h.upstream).not.toHaveBeenCalled()
  })
  it('rejects a non-admin before querying connection or native identity', async () => {
    h.auth.mockRejectedValueOnce(new Error('Unauthorized'))
    expect((await POST(request({ action: 'verify_phone', job_id: JOB, phone: PHONE }), context)).status).toBe(403)
    expect(h.upstream).not.toHaveBeenCalled()
  })
  it('verifies a phone only by same-session reverse LID proof before writing', async () => {
    const fixture = db()
    h.auth.mockResolvedValue({ accountId: ACCOUNT, adminDb: fixture })
    const response = await POST(request({ action: 'verify_phone', job_id: JOB, phone: PHONE }), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ verified: true, queued: true })
    expect(h.upstream).toHaveBeenCalledWith('/api/sessions/sess/contacts/967700000001/lid', { timeoutMs: 7000 })
    expect(fixture.updates[0]).toMatchObject({
      verified_phone: PHONE, verification_source: 'openwa_reverse_lid', state: 'pending',
    })
    expect(fixture.queries.some(x => x.table === 'openwa_deferred_events' &&
      x.filters.account_id === ACCOUNT && x.filters.connection_id === CONNECTION)).toBe(true)
  })
  it('rechecks a pending LID before exhausting retry attempts', async () => {
    const fixture = db()
    h.auth.mockResolvedValue({ accountId: ACCOUNT, adminDb: fixture })
    const response = await POST(request({ action: 'verify_phone', job_id: JOB, phone: PHONE }), context)
    expect(response.status).toBe(200)
    expect(fixture.queries.some(x => x.table === 'openwa_deferred_events' &&
      Array.isArray(x.filters.state) &&
      (x.filters.state as string[]).includes('pending'))).toBe(true)
  })
  it('does not create any mapping when upstream returns a different LID', async () => {
    const fixture = db()
    h.auth.mockResolvedValue({ accountId: ACCOUNT, adminDb: fixture })
    h.upstream.mockResolvedValueOnce({ lid: '999999999999999@lid' })
    expect((await POST(request({ action: 'verify_phone', job_id: JOB, phone: PHONE }), context)).status).toBe(409)
    expect(fixture.updates).toHaveLength(0)
  })
  it('refuses a rebound session, never attempting provider lookup', async () => {
    const fixture = db({ matching: false })
    h.auth.mockResolvedValue({ accountId: ACCOUNT, adminDb: fixture })
    expect((await POST(request({ action: 'verify_phone', job_id: JOB, phone: PHONE }), context)).status).toBe(409)
    expect(h.upstream).not.toHaveBeenCalled()
    expect(fixture.updates).toHaveLength(0)
  })
  it('never treats native LID digits as the telephone number', async () => {
    const fixture = db()
    h.auth.mockResolvedValue({ accountId: ACCOUNT, adminDb: fixture })
    expect((await POST(request({ action: 'verify_phone', job_id: JOB, phone: '123456789012345' }), context)).status).toBe(409)
    expect(h.upstream).not.toHaveBeenCalled()
  })
  it('classifies a bounded exact native-ID sample without exposing native identities', async () => {
    const native = 'true_123@lid_NATIVE'
    const queries: Array<{ table: string; filters: Record<string, unknown> }> = []
    const from = vi.fn((table: string) => {
      const filters: Record<string, unknown> = {}
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => { filters[key] = value; return q },
        is: () => q,
        in: (key: string, values: unknown[]) => { filters[key] = values; return q },
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: { id: CONNECTION }, error: null }),
        then: (resolve: (result: unknown) => void) => {
          queries.push({ table, filters: { ...filters } })
          const rows = table === 'openwa_deferred_events'
            ? 'event_kind' in filters
              ? []
              : ('provider_message_id' in filters ? [] : [
                {id:JOB,event_kind:'unmatched_status',state:'pending',attempt_count:3,
                 last_error_code:'native_message_not_found',created_at:'2026-11-19T00:00:00Z',
                 updated_at:'2026-11-19T00:00:00Z',provider_message_id:native},
              ])
            : table === 'messages'
              ? [{provider_message_id:native,sender_type:'agent'}] : []
          return Promise.resolve(resolve({ data: rows, error: null }))
        },
      }
      return q
    })
    h.auth.mockResolvedValue({ accountId: ACCOUNT, adminDb: { from } })
    const response = await GET(new Request(ENDPOINT), context)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.sample[0].ack_correlation).toBe('candidate_outbound_message')
    expect(body.ack_triage).toMatchObject({
      sampled:1,provider_verified:false,categories:{candidate_outbound_message:1},
    })
    expect(JSON.stringify(body)).not.toContain(native)
    for (const table of ['messages','broadcast_recipients']) {
      expect(queries).toContainEqual({
        table, filters:{connection_id:CONNECTION,provider:'openwa',provider_message_id:[native]},
      })
    }
  })
  it('does not run global native-ID queries when there are no unresolved ACKs', async () => {
    const fixture = db()
    h.auth.mockResolvedValue({ accountId: ACCOUNT, adminDb: fixture })
    const response = await GET(new Request(ENDPOINT), context)
    expect(response.status).toBe(200)
    expect(fixture.from).not.toHaveBeenCalledWith('messages')
    expect(fixture.from).not.toHaveBeenCalledWith('broadcast_recipients')
  })
  it('refuses all diagnostic rows to non-admins before any service query', async () => {
    h.auth.mockRejectedValueOnce(new Error('Unauthorized'))
    const response = await GET(new Request(ENDPOINT), context)
    expect(response.status).toBe(403)
    expect(h.resolveClient).not.toHaveBeenCalled()
  })
  it('reads safe diagnostics only from the scoped account and connection', async () => {
    const fixture = db()
    h.auth.mockResolvedValue({ accountId: ACCOUNT, adminDb: fixture })
    const response = await GET(new Request(ENDPOINT), context)
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload).not.toHaveProperty('native_chat_id')
    expect(fixture.queries).toContainEqual(expect.objectContaining({
      table: 'whatsapp_connections',
      filters: expect.objectContaining({ account_id: ACCOUNT, id: CONNECTION }),
    }))
  })
})
