import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  dbFrom: vi.fn(),
  userFrom: vi.fn(),
  rpc: vi.fn(),
  approvedTerms: vi.fn(),
}))
vi.mock('@/lib/auth/account', () => {
  class UnauthorizedError extends Error {}
  class ForbiddenError extends Error {}
  return { requireRole: h.requireRole, UnauthorizedError, ForbiddenError }
})
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ from: h.dbFrom, rpc: h.rpc }),
}))
vi.mock('@/lib/whatsapp/transport/openwa/approved-policy-catalog', () => ({
  getApprovedOpenWATerms: h.approvedTerms,
}))

import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account'
import { GET, POST } from './route'

const ACCOUNT = '56e9496b-2f4b-4a11-84cb-9c5a3af670b0'
const USER = 'f96e020e-b51f-4d63-86f5-843ae3180729'
const REQUEST_ID = '404107aa-83e5-459c-b396-11f3ac995fb7'
const CONNECTION = '972b3d10-6bb5-47a3-ad33-62a96f52cd8a'
const EVENT = 'd60bdd0f-a8b2-429c-8dfd-039800437bbc'
const VERSION = 'openwa-approved-test-policy'
const DIGEST = 'a'.repeat(64)

function dbQuery(data: unknown, error: unknown = null) {
  const result = { data, error }
  const q = {
    select: vi.fn(), eq: vi.fn(), is: vi.fn(), order: vi.fn(), limit: vi.fn(),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  }
  for (const fn of [q.select, q.eq, q.is, q.order, q.limit]) fn.mockReturnValue(q)
  return q
}
function request(body: unknown, origin = 'http://localhost:3000') {
  return new Request('http://localhost:3000/api/whatsapp/connections/openwa/operational-policy', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
function accept(extra?: Record<string, unknown>) {
  return { action: 'accept', policy_version: VERSION, policy_digest: DIGEST,
    acknowledge_risks: true, expected_revision: 0, request_id: REQUEST_ID,
    ...extra }
}

let policy: unknown
let consent: unknown
let connectionState: unknown[]
let connections: unknown[]
let consentAudit: unknown[]
let activationAudit: unknown[]
let databaseError: string | null

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
  vi.stubEnv('WACRM_W07_CONTROL_WRITES_ENABLED', '')
  policy = null
  consent = null
  connectionState = []
  connections = [{ id: CONNECTION, display_name: 'TEST gateway', status: 'ready',
    session_id: 'private-session-id-not-for-client' }]
  consentAudit = []
  activationAudit = []
  databaseError = null
  h.approvedTerms.mockReturnValue({ ar: 'Approved Arabic disclosure', en: 'Approved English disclosure' })
  h.requireRole.mockResolvedValue({
    accountId: ACCOUNT, userId: USER, role: 'owner', supabase: { from: h.userFrom },
  })
  h.dbFrom.mockImplementation((table: string) => {
    const failure = databaseError === table ? { message: 'PRIVATE_DB_ERROR' } : null
    switch (table) {
      case 'whatsapp_openwa_policy_versions': return dbQuery(policy, failure)
      case 'whatsapp_openwa_consent_state': return dbQuery(consent, failure)
      case 'whatsapp_openwa_activation_state': return dbQuery(connectionState, failure)
      case 'whatsapp_openwa_consent_audit': return dbQuery(consentAudit, failure)
      case 'whatsapp_openwa_activation_audit': return dbQuery(activationAudit, failure)
      default: throw new Error('unexpected table ' + table)
    }
  })
  h.userFrom.mockImplementation((table: string) => {
    if (table !== 'whatsapp_connections') throw new Error('unexpected user query')
    return dbQuery(connections)
  })
  h.rpc.mockResolvedValue({ data: { updated: true, status: 'accepted', revision: 1 }, error: null })
})
afterEach(() => vi.unstubAllEnvs())

describe('W07-03 tenant/owner policy API', () => {
  it('returns only sanitized admin status, with all connections effectively blocked until W07-04', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    const json = await res.json()
    expect(json.meta_remains_default).toBe(true)
    expect(json.operational_gate).toBe('enforce_release')
    expect(json.production_send_authorized).toBe(false)
    expect(json.policy.approved).toBe(false)
    expect(json.consent.revision).toBe(0)
    expect(json.connections[0]).toMatchObject({
      connection_id: CONNECTION, requested_activation: 'disabled',
      activation_revision: 0, send_authorized: false, reason: 'policy_not_approved',
    })
    expect(JSON.stringify(json)).not.toContain('private-session-id-not-for-client')
    expect(h.userFrom).toHaveBeenCalledWith('whatsapp_connections')
    for (const table of [
      'whatsapp_openwa_policy_versions', 'whatsapp_openwa_consent_state',
      'whatsapp_openwa_activation_state', 'whatsapp_openwa_consent_audit',
      'whatsapp_openwa_activation_audit',
    ]) expect(h.dbFrom).toHaveBeenCalledWith(table)
  })

  it('does not assert send authorization from an approved policy or a requested enabled connection', async () => {
    policy = { version: VERSION, digest: DIGEST, approved_at: new Date().toISOString() }
    consent = { status: 'accepted', policy_version: VERSION, policy_digest: DIGEST,
      accepted_event_id: EVENT, revision: 1, updated_at: new Date().toISOString() }
    connectionState = [{ connection_id: CONNECTION, status: 'enabled', consent_event_id: EVENT,
      revision: 1, updated_at: new Date().toISOString() }]
    const res = await GET()
    const body = await res.json()
    expect(body.consent.current).toBe(true)
    expect(body.connections[0]).toMatchObject({
      requested_activation: 'enabled', reason: 'deployment_release_disabled',
      send_authorized: false,
    })
    expect(body.production_send_authorized).toBe(false)
    expect(JSON.stringify(body)).not.toContain(EVENT)
  })

  it('distinguishes an installed W07 admission gate from an actual per-message send permission', async () => {
    policy = { version: VERSION, digest: DIGEST, approved_at: new Date().toISOString() }
    consent = { status: 'accepted', policy_version: VERSION, policy_digest: DIGEST,
      accepted_event_id: EVENT, revision: 1, updated_at: new Date().toISOString() }
    connectionState = [{ connection_id: CONNECTION, status: 'enabled', consent_event_id: EVENT,
      revision: 1, updated_at: new Date().toISOString() }]
    vi.stubEnv('WACRM_OPENWA_PRODUCTION_RELEASE_ENABLED', 'true')
    const res = await GET()
    const body = await res.json()
    expect(body).toMatchObject({ operational_gate: 'enforce_release',
      deployment_release_enabled: true, production_send_authorized: false })
    expect(body.connections[0]).toMatchObject({
      reason: 'request_admission_required', send_authorized: false })
    expect(JSON.stringify(body)).not.toContain('private-session-id-not-for-client')
  })

  it('protects account details from nonadmin/unauthenticated callers', async () => {
    h.requireRole.mockRejectedValueOnce(new UnauthorizedError())
    expect((await GET()).status).toBe(401)
    h.requireRole.mockRejectedValueOnce(new ForbiddenError())
    expect((await GET()).status).toBe(403)
    expect(h.dbFrom).not.toHaveBeenCalled()
  })

  it('fails closed without revealing DB data if a read errors', async () => {
    databaseError = 'whatsapp_openwa_consent_state'
    const res = await GET()
    expect(res.status).toBe(503)
    expect(JSON.stringify(await res.json())).not.toContain('PRIVATE_DB_ERROR')
  })

  it('denies forged actor/account, malformed input and cross-site write before database RPC', async () => {
    expect((await POST(request(accept({ account_id: ACCOUNT })))).status).toBe(400)
    expect((await POST(request(accept({ actor_id: USER })))).status).toBe(400)
    expect((await POST(request(accept({ policy_digest: 'secret' })))).status).toBe(400)
    expect((await POST(request(accept({ acknowledge_risks: false })))).status).toBe(400)
    expect((await POST(request(accept(), 'https://attacker.example'))).status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('fails closed when a DB-approved digest has no matching published legal wording', async () => {
    vi.stubEnv('WACRM_W07_CONTROL_WRITES_ENABLED', 'true')
    h.approvedTerms.mockReturnValue(null)
    const result = await POST(request(accept()))
    expect(result.status).toBe(409)
    expect(await result.json()).toMatchObject({ code: 'policy_terms_unavailable' })
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('only returns approved disclosure wording after catalog version/digest verification', async () => {
    policy = { version: VERSION, digest: DIGEST, approved_at: new Date().toISOString() }
    h.approvedTerms.mockReturnValueOnce(null)
    const noText = await (await GET()).json()
    expect(noText.policy).toMatchObject({ approved: true, terms: null })
    expect(noText.mutation_stage.owner_accept_available).toBe(false)
    vi.stubEnv('WACRM_W07_CONTROL_WRITES_ENABLED', 'true')
    const reviewed = await (await GET()).json()
    expect(reviewed.policy.terms).toEqual({
      ar: 'Approved Arabic disclosure', en: 'Approved English disclosure',
    })
    expect(reviewed.mutation_stage.owner_accept_available).toBe(true)
  })

  it('keeps accept closed by default, but permits independently owner-scoped revocation', async () => {
    expect((await POST(request(accept()))).status).toBe(409)
    expect(h.rpc).not.toHaveBeenCalled()
    h.rpc.mockResolvedValueOnce({ data: { updated: true, status: 'revoked', revision: 2 }, error: null })
    const res = await POST(request({ action: 'revoke', expected_revision: 1, request_id: REQUEST_ID }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ applied: true, recorded_status: 'revoked', send_authorized: false })
    expect(h.rpc).toHaveBeenCalledWith('set_openwa_operational_consent', {
      p_account_id: ACCOUNT, p_actor: USER, p_action: 'revoke',
      p_policy_version: null, p_policy_digest: null,
      p_expected_revision: 1, p_request_id: REQUEST_ID,
    })
  })

  it('accepts only from authenticated owner after explicit stage gate; never uses claimed identity', async () => {
    vi.stubEnv('WACRM_W07_CONTROL_WRITES_ENABLED', 'true')
    const res = await POST(request(accept()))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ applied: true, send_authorized: false })
    expect(h.requireRole).toHaveBeenCalledWith('owner')
    expect(h.rpc).toHaveBeenCalledWith('set_openwa_operational_consent', {
      p_account_id: ACCOUNT, p_actor: USER, p_action: 'accept',
      p_policy_version: VERSION, p_policy_digest: DIGEST,
      p_expected_revision: 0, p_request_id: REQUEST_ID,
    })
  })

  it('preserves SQL conflict, replay and unavailable error responses', async () => {
    vi.stubEnv('WACRM_W07_CONTROL_WRITES_ENABLED', 'true')
    h.rpc.mockResolvedValueOnce({ data: { updated: false, reason: 'policy_not_approved' }, error: null })
    expect((await POST(request(accept()))).status).toBe(409)
    h.rpc.mockResolvedValueOnce({ data: { updated: false, reason: 'revision_conflict', revision: 4 }, error: null })
    const conflict = await POST(request(accept()))
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: 'revision_conflict', revision: 4, send_authorized: false })
    h.rpc.mockResolvedValueOnce({ data: { updated: false, idempotent: true, status: 'accepted', revision: 1 }, error: null })
    const replay = await POST(request(accept()))
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ replayed: true, state_requires_refresh: true })
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'DB PRIVATE SECRET' } })
    const error = await POST(request(accept()))
    expect(error.status).toBe(503)
    expect(JSON.stringify(await error.json())).not.toContain('DB PRIVATE SECRET')
  })

  it('rejects non-owners on write even if stage flag is enabled', async () => {
    vi.stubEnv('WACRM_W07_CONTROL_WRITES_ENABLED', 'true')
    h.requireRole.mockRejectedValueOnce(new ForbiddenError())
    expect((await POST(request(accept()))).status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})
