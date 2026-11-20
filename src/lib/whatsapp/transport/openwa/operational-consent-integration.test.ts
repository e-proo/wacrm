import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveOpenWATransport } from './adapter'
import { resolveOpenWAClient } from './credentials'
import { GuardedOpenWATransport, OpenWAPreDispatchDenied } from '../guardrails'
import type { WhatsAppSendWorkload, WhatsAppTransportSendRequest } from '../types'

vi.mock('./credentials', () => ({ resolveOpenWAClient: vi.fn() }))

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const CONNECTION = '22222222-2222-4222-8222-222222222222'
const EVENT = '33333333-3333-4333-8333-333333333333'
const VERSION = 'reviewed-policy-v1'
const DIGEST = 'a'.repeat(64)
const SESSION = 'openwa-session-123'

type SetupOpts = {
  /** The first admission succeeds but consent is revoked before the raw adapter. */
  revokeAfterPreflight?: boolean
  /** The first admission succeeds but the provider session is rotated. */
  rotateAfterPreflight?: boolean
  /** The first admission succeeds but requested connection activation is suspended. */
  suspendAfterPreflight?: boolean
  pausedAtGuard?: boolean
}
function setup(options: SetupOpts = {}) {
  const sendText = vi.fn(async () => ({ providerMessageId: 'native-123', raw: { accepted: true } }))
  const sendMedia = vi.fn(async () => ({ providerMessageId: 'native-image', raw: { accepted: true } }))
  vi.mocked(resolveOpenWAClient).mockResolvedValue({
    credentials: {} as never,
    client: { sendText, sendMedia } as never,
  })
  let consentReads = 0
  const lookups: Array<{ table: string; filters: Record<string, unknown> }> = []
  const db = {
    rpc: vi.fn(async (name: string, _args?: Record<string, unknown>) => {
      if (name === 'reserve_openwa_guardrail_send') {
        return { data: { allowed: true, wait_ms: 0 }, error: null }
      }
      if (name === 'record_openwa_guardrail_outcome') {
        return { data: null, error: null }
      }
      throw Error('unexpected RPC: ' + name)
    }),
    from: vi.fn((table: string) => {
      const filters: Record<string, unknown> = {}
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn((key: string, val: unknown) => { filters[key] = val; return query }),
        is: vi.fn((key: string, val: unknown) => { filters[key] = val; return query }),
        maybeSingle: vi.fn(async () => {
          lookups.push({ table, filters: { ...filters } })
          if (table === 'whatsapp_connection_guardrails') {
            return { data: { manual_paused: options.pausedAtGuard ?? false, circuit_open_until: null }, error: null }
          }
          if (table === 'whatsapp_connections') {
            return { data: {
              id: CONNECTION, account_id: ACCOUNT, provider: 'openwa',
              status: 'ready',
              session_id: options.rotateAfterPreflight && consentReads > 1 ? 'new-session' : SESSION,
            }, error: null }
          }
          if (table === 'whatsapp_openwa_policy_versions') {
            return { data: { version: VERSION, digest: DIGEST }, error: null }
          }
          if (table === 'whatsapp_openwa_consent_state') {
            consentReads++
            return { data: options.revokeAfterPreflight && consentReads > 1
              ? { status: 'revoked', policy_version: VERSION, policy_digest: DIGEST, accepted_event_id: EVENT }
              : { status: 'accepted', policy_version: VERSION, policy_digest: DIGEST, accepted_event_id: EVENT },
              error: null }
          }
          if (table === 'whatsapp_openwa_activation_state') {
            return { data: options.suspendAfterPreflight && consentReads > 1
              ? { status: 'suspended', consent_event_id: null }
              : { status: 'enabled', consent_event_id: EVENT }, error: null }
          }
          if (table === 'whatsapp_openwa_consent_audit') {
            return { data: { action: 'accept', policy_version: VERSION, policy_digest: DIGEST }, error: null }
          }
          throw Error('unexpected table ' + table)
        }),
      }
      return query
    }),
  }
  return { db: db as unknown as SupabaseClient, rpc: db.rpc, lookups, sendText, sendMedia,
    get consentReads() { return consentReads } }
}

const request = (workload: WhatsAppSendWorkload, content: WhatsAppTransportSendRequest['content'] = {
  kind: 'text', text: 'W07 synthetic message',
}): WhatsAppTransportSendRequest => ({
  accountId: ACCOUNT, connectionId: CONNECTION, recipient: '967700000001',
  idempotencyKey: 'immutable-reservation-id-123', workload, content,
})
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://non-test-project.supabase.co')
  vi.stubEnv('OPENWA_PILOT_MODE', 'off')
  vi.stubEnv('WACRM_OPENWA_PRODUCTION_RELEASE_ENABLED', 'true')
})
afterEach(() => vi.unstubAllEnvs())

describe('W07-04 actual guarded adapter entry and last-chance provider-bound admission', () => {
  it.each(['manual','automation','broadcast','agent','api'] as WhatsAppSendWorkload[])(
    'checks %s workload before reservation and again before sending, without changing idempotency',
    async (workload) => {
      const t = setup()
      const raw = await resolveOpenWATransport(t.db, ACCOUNT, CONNECTION)
      const transport = new GuardedOpenWATransport(t.db, raw.transport)
      const result = await transport.send(request(workload))
      expect(result.provider).toBe('openwa')
      expect(result.providerMessageId).toBe('native-123')
      expect(t.sendText).toHaveBeenCalledTimes(1)
      expect(t.sendText).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: SESSION, idempotencyKey: 'immutable-reservation-id-123' }),
        'immutable-reservation-id-123',
      )
      expect(t.consentReads).toBe(2)
      expect(t.rpc.mock.calls.map(([name]) => name)).toEqual([
        'reserve_openwa_guardrail_send', 'record_openwa_guardrail_outcome',
      ])
      const reserved = t.rpc.mock.calls[0][1] as Record<string, unknown>
      expect(reserved.p_account_id).toBe(ACCOUNT)
      expect(reserved.p_connection_id).toBe(CONNECTION)
      expect(reserved.p_workload).toBe(workload)
      expect(JSON.stringify(reserved)).not.toContain('967700000001')
    },
  )

  it('preserves media send through identical guarded provider admission', async () => {
    const t = setup()
    const raw = await resolveOpenWATransport(t.db, ACCOUNT, CONNECTION)
    const transport = new GuardedOpenWATransport(t.db, raw.transport)
    const result = await transport.send(request('manual', {
      kind: 'media', mediaKind: 'image', link: 'https://example.org/test-image.png', caption: 'test',
    }))
    expect(result.providerMessageId).toBe('native-image')
    expect(t.sendText).not.toHaveBeenCalled()
    expect(t.sendMedia).toHaveBeenCalledTimes(1)
    expect(t.consentReads).toBe(2)
  })

  it('blocks before guardrail reservation when production release is not authorized', async () => {
    vi.stubEnv('WACRM_OPENWA_PRODUCTION_RELEASE_ENABLED', '')
    const t = setup()
    const raw = await resolveOpenWATransport(t.db, ACCOUNT, CONNECTION)
    const transport = new GuardedOpenWATransport(t.db, raw.transport)
    await expect(transport.send(request('agent'))).rejects.toMatchObject({
      providerDispatchAttempted: false, denialReason: 'operational_release_disabled',
    })
    expect(t.rpc).not.toHaveBeenCalled()
    expect(t.sendText).not.toHaveBeenCalled()
    expect(t.consentReads).toBe(0)
  })

  it('revocation during an in-flight reserved send is caught by the raw adapter and never recorded as provider failure', async () => {
    const t = setup({ revokeAfterPreflight: true })
    const raw = await resolveOpenWATransport(t.db, ACCOUNT, CONNECTION)
    const transport = new GuardedOpenWATransport(t.db, raw.transport)
    const error = await transport.send(request('broadcast')).then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(OpenWAPreDispatchDenied)
    expect(error).toMatchObject({
      denialReason: 'operational_consent_required', providerDispatchAttempted: false,
    })
    expect(t.consentReads).toBe(2)
    expect(t.rpc.mock.calls.map(([name]) => name)).toEqual(['reserve_openwa_guardrail_send'])
    expect(t.sendText).not.toHaveBeenCalled()
  })

  it.each([
    { change: 'session rotation', opts: { rotateAfterPreflight: true }, reason: 'operational_connection_not_ready' },
    { change: 'activation suspension', opts: { suspendAfterPreflight: true }, reason: 'operational_activation_suspended' },
  ])('blocks $change at last provider boundary', async ({ opts, reason }) => {
    const t = setup(opts)
    const raw = await resolveOpenWATransport(t.db, ACCOUNT, CONNECTION)
    const transport = new GuardedOpenWATransport(t.db, raw.transport)
    await expect(transport.send(request('automation'))).rejects.toMatchObject({
      providerDispatchAttempted: false, denialReason: reason,
    })
    expect(t.sendText).not.toHaveBeenCalled()
    expect(t.rpc.mock.calls.map(([name]) => name)).toEqual(['reserve_openwa_guardrail_send'])
  })

  it('honors the emergency STOP even with zero pacing wait and an approved operational policy', async () => {
    const t = setup({ pausedAtGuard: true })
    const raw = await resolveOpenWATransport(t.db, ACCOUNT, CONNECTION)
    const transport = new GuardedOpenWATransport(t.db, raw.transport)
    const result = await transport.send(request('broadcast')).then(() => null, (e: unknown) => e)
    expect(result).toMatchObject({ code: 'connection_restricted', providerDispatchAttempted: false })
    expect(t.rpc.mock.calls.map(([name]) => name)).toEqual(['reserve_openwa_guardrail_send'])
    expect(t.sendText).not.toHaveBeenCalled()
  })

  it('protects direct raw adapter calls from bypassing the guarded router wrapper', async () => {
    vi.stubEnv('WACRM_OPENWA_PRODUCTION_RELEASE_ENABLED', '')
    const t = setup()
    const raw = await resolveOpenWATransport(t.db, ACCOUNT, CONNECTION)
    await expect(raw.transport.send(request('manual'))).rejects.toMatchObject({
      denialReason: 'operational_release_disabled', providerDispatchAttempted: false,
    })
    expect(t.sendText).not.toHaveBeenCalled()
    expect(t.rpc).not.toHaveBeenCalled()
  })
})
