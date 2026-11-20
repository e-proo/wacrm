import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canWriteOpenWAControl, isOpenWAControlSameOrigin, isOpenWAControlUuid,
  mapOpenWAControlOutcome, parseOpenWAActivationMutation, parseOpenWAPolicyMutation,
  readOpenWAControlJson,
} from './operational-control-api'

const ID = '14aac47b-936b-4b60-a980-6687f40f32cc'
const VERSION = 'openwa-approved-terms-2026-v1'
const DIGEST = 'a'.repeat(64)

afterEach(() => vi.unstubAllEnvs())
beforeEach(() => {
  vi.stubEnv('WACRM_W07_CONTROL_WRITES_ENABLED', '')
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
})

describe('W07-03 safe control request contracts', () => {
  it('validates UUIDs and strictly rejects unknown actor/account fields', () => {
    expect(isOpenWAControlUuid(ID)).toBe(true)
    expect(isOpenWAControlUuid('whatever')).toBe(false)
    const valid = { action: 'accept', policy_version: VERSION, policy_digest: DIGEST,
      acknowledge_risks: true, expected_revision: 0, request_id: ID }
    expect(parseOpenWAPolicyMutation(valid).ok).toBe(true)
    expect(parseOpenWAPolicyMutation({ ...valid, account_id: ID }).ok).toBe(false)
    expect(parseOpenWAPolicyMutation({ ...valid, actor_id: ID }).ok).toBe(false)
    expect(parseOpenWAPolicyMutation({ ...valid, acknowledge_risks: false }).ok).toBe(false)
    expect(parseOpenWAPolicyMutation({ ...valid, expected_revision: -1 }).ok).toBe(false)
    expect(parseOpenWAPolicyMutation({ ...valid, expected_revision: 0.1 }).ok).toBe(false)
    expect(parseOpenWAPolicyMutation({ ...valid, expected_revision: Number.MAX_SAFE_INTEGER }).ok).toBe(false)
    expect(parseOpenWAPolicyMutation({ ...valid, policy_digest: 'weak' }).ok).toBe(false)
    expect(parseOpenWAPolicyMutation({ ...valid, request_id: 'not-a-uuid' }).ok).toBe(false)
    expect(parseOpenWAPolicyMutation({ ...valid,
      policy_version: 'ow14-w07-draft-2026-11-20-v1' }).ok).toBe(false)
    expect(parseOpenWAPolicyMutation(null).ok).toBe(false)
  })

  it('accepts only explicit per-session actions with bounded revisions', () => {
    const base = { expected_revision: 1, request_id: ID }
    expect(parseOpenWAActivationMutation({ action: 'enable', confirm_activation: true, ...base }).ok).toBe(true)
    expect(parseOpenWAActivationMutation({ action: 'enable', ...base }).ok).toBe(false)
    expect(parseOpenWAActivationMutation({ action: 'enable', confirm_activation: false, ...base }).ok).toBe(false)
    expect(parseOpenWAActivationMutation({ action: 'disable', ...base }).ok).toBe(true)
    expect(parseOpenWAActivationMutation({ action: 'suspend', ...base }).ok).toBe(true)
    expect(parseOpenWAActivationMutation({ action: 'disable', ...base, account_id: ID }).ok).toBe(false)
    expect(parseOpenWAActivationMutation({ action: 'suspend', confirm_activation: true, ...base }).ok).toBe(false)
    expect(parseOpenWAActivationMutation({ action: 'enabled', ...base }).ok).toBe(false)
  })

  it('requires exact trusted origin and JSON, with a closed production fallback', () => {
    const req = (origin?: string, contentType = 'application/json', otherHeaders: Record<string,string> = {}) =>
      new Request('http://localhost:3000/api/test', {
        method: 'POST', headers: {
          ...(origin ? { origin } : {}), 'content-type': contentType, ...otherHeaders,
        },
        body: '{}',
      })
    expect(isOpenWAControlSameOrigin(req('http://localhost:3000'))).toBe(true)
    expect(isOpenWAControlSameOrigin(req())).toBe(false)
    expect(isOpenWAControlSameOrigin(req('null'))).toBe(false)
    expect(isOpenWAControlSameOrigin(req('https://example.com'))).toBe(false)
    expect(isOpenWAControlSameOrigin(req('http://localhost:3000', 'text/plain'))).toBe(false)
    expect(isOpenWAControlSameOrigin(req('http://localhost:3000', 'application/json', {
      'sec-fetch-site': 'cross-site',
    }))).toBe(false)
    vi.stubEnv('NODE_ENV', 'production')
    expect(isOpenWAControlSameOrigin(req('http://localhost:3000'))).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.test')
    expect(isOpenWAControlSameOrigin(req('https://crm.example.test'))).toBe(true)
    expect(isOpenWAControlSameOrigin(req('http://localhost:3000'))).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://localhost:3000')
    expect(isOpenWAControlSameOrigin(req('http://localhost:3000'))).toBe(false)
  })

  it('keeps acceptance and enablement disabled unless stage is explicitly opted in', () => {
    expect(canWriteOpenWAControl('accept')).toBe(false)
    expect(canWriteOpenWAControl('enable')).toBe(false)
    expect(canWriteOpenWAControl('revoke')).toBe(true)
    expect(canWriteOpenWAControl('disable')).toBe(true)
    expect(canWriteOpenWAControl('suspend')).toBe(true)
    vi.stubEnv('WACRM_W07_CONTROL_WRITES_ENABLED', 'true')
    expect(canWriteOpenWAControl('accept')).toBe(true)
    expect(canWriteOpenWAControl('enable')).toBe(true)
    vi.stubEnv('WACRM_W07_CONTROL_WRITES_ENABLED', '1')
    expect(canWriteOpenWAControl('accept')).toBe(false)
  })

  it('does not reveal DB errors, secrets, or claim current delivery on replay', () => {
    expect(mapOpenWAControlOutcome({ updated: true, status: 'enabled', revision: 1 }))
      .toEqual({ status: 200, body: {
        applied: true, recorded_status: 'enabled', revision: 1,
        send_authorized: false, state_requires_refresh: true,
      } })
    expect(mapOpenWAControlOutcome({ updated: false, idempotent: true,
      status: 'accepted', revision: 1 }).body).toMatchObject({
      applied: false, replayed: true, send_authorized: false, state_requires_refresh: true,
    })
    expect(mapOpenWAControlOutcome({ updated: false, reason: 'revision_conflict', revision: 8 }))
      .toMatchObject({ status: 409, body: { code: 'revision_conflict', revision: 8 } })
    expect(mapOpenWAControlOutcome({ updated: false, reason: 'actor_forbidden' }).status).toBe(403)
    expect(mapOpenWAControlOutcome({ updated: false, reason: 'connection_scope_mismatch' }).status).toBe(404)
    expect(mapOpenWAControlOutcome({ updated: false, reason: 'invalid_request' }).status).toBe(400)
    const unknown = mapOpenWAControlOutcome({ reason: 'super_secret_database_error' })
    expect(unknown.status).toBe(503)
    expect(JSON.stringify(unknown)).not.toContain('super_secret_database_error')
    expect(mapOpenWAControlOutcome(null).status).toBe(503)
    expect(mapOpenWAControlOutcome({ updated: true, status: 'delivered' }).status).toBe(503)
  })

  it('bounds JSON parsing for ordinary and chunked oversized requests', async () => {
    const make = (body: string) => new Request('http://localhost:3000/api/control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    })
    expect(await readOpenWAControlJson(make('{"action":"review"}'))).toEqual({ action: 'review' })
    expect(await readOpenWAControlJson(make('{wrong'))).toBeNull()
    expect(await readOpenWAControlJson(make(JSON.stringify({ large: 'x'.repeat(8000) })))).toBeNull()
  })
})
