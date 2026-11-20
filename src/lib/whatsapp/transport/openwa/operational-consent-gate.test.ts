import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { assertOpenWAOperationalSendAllowed, openWAOperationalGateMode } from './operational-consent-gate'
import { OpenWAPreDispatchDenied } from './pre-dispatch-denied'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const CONNECTION = '33333333-3333-4333-8333-333333333333'
const EVENT = '44444444-4444-4444-8444-444444444444'
const OTHER_EVENT = '55555555-5555-4555-8555-555555555555'
const VERSION = 'openwa-reviewed-policy-v1'
const DIGEST = 'a'.repeat(64)
const TEST = 'https://pqirsnfupofhulmewakq.supabase.co'
const PROD = 'https://some-other-project.supabase.co'

type Fixture = {
  policy?: Record<string, unknown> | null
  consent?: Record<string, unknown> | null
  activation?: Record<string, unknown> | null
  event?: Record<string, unknown> | null
  connection?: Record<string, unknown> | null
  errors?: string[]
}
function setup(fixture: Fixture = {}) {
  const rows: Record<string, Record<string, unknown> | null> = {
    whatsapp_openwa_policy_versions: fixture.policy === undefined ? { version: VERSION, digest: DIGEST } : fixture.policy,
    whatsapp_openwa_consent_state: fixture.consent === undefined ? {
      status: 'accepted', policy_version: VERSION, policy_digest: DIGEST, accepted_event_id: EVENT,
    } : fixture.consent,
    whatsapp_openwa_activation_state: fixture.activation === undefined ? {
      status: 'enabled', consent_event_id: EVENT,
    } : fixture.activation,
    whatsapp_openwa_consent_audit: fixture.event === undefined ? {
      action: 'accept', policy_version: VERSION, policy_digest: DIGEST,
    } : fixture.event,
    whatsapp_connections: fixture.connection === undefined ? {
      status: 'ready', session_id: 'session-1',
    } : fixture.connection,
  }
  const lookups: { table: string; filters: Record<string, unknown>; nullChecks: Record<string, unknown> }[] = []
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {}
    const nullChecks: Record<string, unknown> = {}
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((key: string, value: unknown) => { filters[key] = value; return query }),
      is: vi.fn((key: string, value: unknown) => { nullChecks[key] = value; return query }),
      maybeSingle: vi.fn(async () => {
        lookups.push({ table, filters: { ...filters }, nullChecks: { ...nullChecks } })
        if (fixture.errors?.includes(table)) return { data: null, error: { message: 'DB_SECRET' } }
        if (!(table in rows)) throw Error('Unexpected W07 table ' + table)
        const scoped = (
          (!('account_id' in filters) || filters.account_id === ACCOUNT) &&
          (!('connection_id' in filters) || filters.connection_id === CONNECTION) &&
          (!('id' in filters) || (table === 'whatsapp_connections'
            ? filters.id === CONNECTION : filters.id === EVENT)) &&
          (!('provider' in filters) || filters.provider === 'openwa')
        )
        return { data: scoped ? rows[table] : null, error: null }
      }),
    }
    return query
  })
  return { db: { from } as unknown as SupabaseClient, from, lookups }
}

async function denied(db: SupabaseClient, reason: string, account = ACCOUNT, connection = CONNECTION, expectedSessionId?: string) {
  let result: unknown = null
  try {
    await assertOpenWAOperationalSendAllowed(db, account, connection, expectedSessionId)
  } catch (error) {
    result = error
  }
  expect(result).toBeInstanceOf(OpenWAPreDispatchDenied)
  expect(result).toMatchObject({ code: 'connection_restricted',
    providerDispatchAttempted: false, denialReason: reason })
  expect((result as Error).message).not.toContain(ACCOUNT)
  expect((result as Error).message).not.toContain(CONNECTION)
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', PROD)
  vi.stubEnv('WACRM_W07_TEST_GATE_MODE', '')
  vi.stubEnv('WACRM_OPENWA_PRODUCTION_RELEASE_ENABLED', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('W07-04 fail-closed outbound operational gate', () => {
  it('requires a dedicated server deployment release gate on non-TEST before any DB access', async () => {
    const x = setup()
    expect(openWAOperationalGateMode()).toBe('enforce_release')
    await denied(x.db, 'operational_release_disabled')
    expect(x.from).not.toHaveBeenCalled()
    vi.stubEnv('WACRM_OPENWA_PRODUCTION_RELEASE_ENABLED', '1')
    await denied(x.db, 'operational_release_disabled')
    expect(x.from).not.toHaveBeenCalled()
  })

  it('preserves the pinned TEST Pilot by default; supports explicit opt-in test verification', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', TEST)
    const x = setup({ policy: null })
    expect(openWAOperationalGateMode()).toBe('legacy_test')
    await expect(assertOpenWAOperationalSendAllowed(x.db, ACCOUNT, CONNECTION)).resolves.toBeUndefined()
    expect(x.from).not.toHaveBeenCalled()
    vi.stubEnv('WACRM_W07_TEST_GATE_MODE', 'enforce')
    expect(openWAOperationalGateMode()).toBe('enforce_test')
    await denied(x.db, 'operational_policy_not_approved')
    vi.stubEnv('WACRM_W07_TEST_GATE_MODE', 'off')
    await denied(x.db, 'operational_test_configuration_invalid')
  })

  it('never applies the TEST carve-out to a spoofed, malformed or unknown Supabase URL', async () => {
    for (const url of [
      TEST + '.attacker.test', TEST.replace('https:', 'http:'), '', 'https://new-project.supabase.co',
    ]) {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', url)
      const x = setup()
      expect(openWAOperationalGateMode()).toBe('enforce_release')
      await denied(x.db, 'operational_release_disabled')
    }
  })

  it('fails closed for missing schema/DB failure and absence of reviewed current policy', async () => {
    vi.stubEnv('WACRM_OPENWA_PRODUCTION_RELEASE_ENABLED', 'true')
    await denied(setup({ errors: ['whatsapp_openwa_policy_versions'] }).db, 'operational_evidence_unavailable')
    await denied(setup({ policy: null }).db, 'operational_policy_not_approved')
    await denied(setup({ policy: { version: VERSION, digest: 'broken' } }).db, 'operational_policy_not_approved')
    await denied(setup({ errors: ['whatsapp_openwa_consent_state'] }).db, 'operational_evidence_unavailable')
  })

  it('rejects missing, revoked, old policy or missing activation despite release flag', async () => {
    vi.stubEnv('WACRM_OPENWA_PRODUCTION_RELEASE_ENABLED', 'true')
    await denied(setup({ consent: null }).db, 'operational_consent_required')
    await denied(setup({ consent: { status: 'revoked', accepted_event_id: EVENT } }).db, 'operational_consent_required')
    await denied(setup({ consent: {
      status: 'accepted', policy_version: 'old-version', policy_digest: DIGEST, accepted_event_id: EVENT,
    } }).db, 'operational_consent_outdated')
    await denied(setup({ activation: null }).db, 'operational_activation_required')
    await denied(setup({ activation: { status: 'disabled', consent_event_id: null } }).db, 'operational_activation_required')
    await denied(setup({ activation: { status: 'suspended', consent_event_id: null } }).db, 'operational_activation_suspended')
  })

  it('rejects old acceptance event after owner reaccepts, mismatched audit or missing evidence', async () => {
    vi.stubEnv('WACRM_OPENWA_PRODUCTION_RELEASE_ENABLED', 'true')
    await denied(setup({ activation: { status: 'enabled', consent_event_id: OTHER_EVENT } }).db, 'operational_consent_changed')
    await denied(setup({ event: null }).db, 'operational_consent_changed')
    await denied(setup({ event: { action: 'revoke', policy_version: VERSION, policy_digest: DIGEST } }).db, 'operational_consent_changed')
    await denied(setup({ event: { action: 'accept', policy_version: 'old', policy_digest: DIGEST } }).db, 'operational_consent_changed')
    await denied(setup({ errors: ['whatsapp_openwa_consent_audit'] }).db, 'operational_evidence_unavailable')
  })

  it('rejects wrong account/provider, archived/disconnected or rotated session immediately before provider', async () => {
    vi.stubEnv('WACRM_OPENWA_PRODUCTION_RELEASE_ENABLED', 'true')
    await denied(setup().db, 'operational_consent_required', OTHER)
    await denied(setup().db, 'operational_activation_required', ACCOUNT, OTHER)
    await denied(setup({ connection: null }).db, 'operational_connection_scope_mismatch')
    await denied(setup({ connection: { status: 'disconnected', session_id: 'session-1' } }).db, 'operational_connection_not_ready')
    await denied(setup({ connection: { status: 'ready', session_id: null } }).db, 'operational_connection_not_ready')
    await denied(setup().db, 'operational_connection_not_ready', ACCOUNT, CONNECTION, 'stale-session')
  })

  it('accepts ONLY tenant-scoped matching version, event, activation, and a ready session', async () => {
    vi.stubEnv('WACRM_OPENWA_PRODUCTION_RELEASE_ENABLED', 'true')
    const x = setup()
    await expect(assertOpenWAOperationalSendAllowed(x.db, ACCOUNT, CONNECTION, 'session-1')).resolves.toBeUndefined()
    expect(x.lookups.map(({ table }) => table)).toEqual([
      'whatsapp_openwa_policy_versions', 'whatsapp_openwa_consent_state',
      'whatsapp_openwa_activation_state', 'whatsapp_openwa_consent_audit', 'whatsapp_connections',
    ])
    const tenantQueries = x.lookups.filter((x) => x.table !== 'whatsapp_openwa_policy_versions')
    expect(tenantQueries.every((x) => x.filters.account_id === ACCOUNT)).toBe(true)
    expect(tenantQueries.filter(x => x.table === 'whatsapp_connections')[0].filters)
      .toMatchObject({ id: CONNECTION, provider: 'openwa' })
    expect(tenantQueries.filter(x => x.table === 'whatsapp_connections')[0].nullChecks)
      .toMatchObject({ archived_at: null })
    await denied(x.db, 'operational_connection_not_ready', ACCOUNT, CONNECTION, 'rotated-session')
  })
})
