import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GuardedOpenWATransport, canonicalOpenWAPilotRecipient, openWAPilotEnforcementEnabled, openWAPilotRecipientHash } from './guardrails'
import { WhatsAppTransportError, type WhatsAppTransport, type WhatsAppTransportSendResult } from './types'

const request = { accountId: 'acc-1', connectionId: 'conn-1', recipient: '967700000001', content: { kind: 'text' as const, text: 'hi' }, idempotencyKey: 'idem-1' }

afterEach(() => vi.unstubAllEnvs())

function setup(reservation: Record<string, unknown>, sendImpl?: () => Promise<WhatsAppTransportSendResult>) {
  const rpc = vi.fn().mockResolvedValueOnce({ data: reservation, error: null }).mockResolvedValue({ data: null, error: null })
  const db = { rpc } as unknown as SupabaseClient
  const defaultSend = async (): Promise<WhatsAppTransportSendResult> => ({ provider: 'openwa', connectionId: 'conn-1', providerMessageId: 'p-1' })
  const inner: WhatsAppTransport = { provider: 'openwa', send: vi.fn(sendImpl ?? defaultSend) }
  return { rpc, inner, guarded: new GuardedOpenWATransport(db, inner) }
}

function pilotSetup(options: { admitted?: boolean; paused?: boolean; circuitUntil?: string | null; rpcError?: boolean; fenceError?: boolean; waitMs?: number } = {}) {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'check_openwa_pilot_admission') return { data: { allowed: options.admitted ?? false }, error: options.rpcError ? { code: 'PGRST202' } : null }
    if (name === 'reserve_openwa_guardrail_send') return { data: { allowed: true, wait_ms: options.waitMs ?? 0 }, error: null }
    if (name === 'record_openwa_guardrail_outcome') return { data: null, error: null }
    throw Error('Unexpected RPC in pilot simulation')
  })
  const filters: Array<[string, unknown]> = []
  const query = {
    select: () => query,
    eq: (key: string, value: unknown) => { filters.push([key, value]); return query },
    maybeSingle: async () => ({ data: options.paused === undefined && options.fenceError
      ? null : { manual_paused: options.paused ?? false, circuit_open_until: options.circuitUntil ?? null },
      error: options.fenceError ? { code: 'PGRST202' } : null }),
  }
  const from = vi.fn(() => query)
  const db = { rpc, from } as unknown as SupabaseClient
  const send = vi.fn(async (): Promise<WhatsAppTransportSendResult> => ({ provider: 'openwa', connectionId: 'conn-1', providerMessageId: 'provider-mock-1' }))
  const transport: WhatsAppTransport = { provider: 'openwa', send }
  return { rpc, from, filters, send, guarded: new GuardedOpenWATransport(db, transport) }
}

describe('OW-10 OpenWA guardrail transport', () => {
  it('blocks before provider call when reservation is denied', async () => {
    const { guarded, inner } = setup({ allowed: false, reason: 'daily_cap' })
    await expect(guarded.send(request)).rejects.toMatchObject({ code: 'connection_restricted' })
    expect(inner.send).not.toHaveBeenCalled()
  })
  it('reserves and records success without exposing recipient in audit arguments', async () => {
    const { guarded, rpc } = setup({ allowed: true, wait_ms: 0 })
    await guarded.send({ ...request, workload: 'broadcast' })
    expect(rpc).toHaveBeenNthCalledWith(1, 'reserve_openwa_guardrail_send', expect.objectContaining({ p_account_id: 'acc-1', p_connection_id: 'conn-1', p_workload: 'broadcast' }))
    const args = rpc.mock.calls[0][1] as Record<string, unknown>
    expect(args.p_recipient_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(args)).not.toContain(request.recipient)
    expect(rpc).toHaveBeenNthCalledWith(2, 'record_openwa_guardrail_outcome', expect.objectContaining({ p_success: true }))
  })
  it('records provider failure and preserves the original transport error', async () => {
    const providerError = new WhatsAppTransportError('connection_restricted', 'logged out')
    const { guarded, rpc } = setup({ allowed: true, wait_ms: 0 }, async () => { throw providerError })
    await expect(guarded.send(request)).rejects.toBe(providerError)
    expect(rpc).toHaveBeenNthCalledWith(2, 'record_openwa_guardrail_outcome', expect.objectContaining({ p_success: false, p_reason: 'connection_restricted' }))
  })
  it('fails closed if guardrail reservation cannot be persisted', async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'db unavailable' } }) } as unknown as SupabaseClient
    const inner: WhatsAppTransport = { provider: 'openwa', send: vi.fn() }
    await expect(new GuardedOpenWATransport(db, inner).send(request)).rejects.toMatchObject({ code: 'retryable_provider_failure' })
    expect(inner.send).not.toHaveBeenCalled()
  })
})

describe('OW-13 server-enforced pilot admission (no real provider calls)', () => {
  it('is inert by default, explicit for enforcement and fails closed for unknown mode', async () => {
    expect(openWAPilotEnforcementEnabled(undefined)).toBe(false)
    expect(openWAPilotEnforcementEnabled('off')).toBe(false)
    expect(openWAPilotEnforcementEnabled('enforce')).toBe(true)
    expect(() => openWAPilotEnforcementEnabled('enabled')).toThrow(WhatsAppTransportError)
    vi.stubEnv('OPENWA_PILOT_MODE', 'broken')
    const t = pilotSetup({ admitted: true })
    await expect(t.guarded.send(request)).rejects.toMatchObject({ code: 'authentication_or_configuration' })
    expect(t.rpc).not.toHaveBeenCalled()
    expect(t.send).not.toHaveBeenCalled()
  })

  it('normalizes exact phone and provider-native JID identities but never converts LIDs', () => {
    expect(canonicalOpenWAPilotRecipient('967700000001')).toBe('967700000001@c.us')
    expect(canonicalOpenWAPilotRecipient('967700000001@c.us')).toBe('967700000001@c.us')
    expect(canonicalOpenWAPilotRecipient('967700000001@lid')).toBe('967700000001@lid')
    expect(canonicalOpenWAPilotRecipient('967700000001@evil.example')).toBeNull()
    expect(canonicalOpenWAPilotRecipient('+967700000001')).toBeNull()
    expect(openWAPilotRecipientHash('acct', 'conn', '967700000001')).toBe(openWAPilotRecipientHash('acct', 'conn', '967700000001@c.us'))
    expect(openWAPilotRecipientHash('acct', 'conn', '967700000001@lid')).not.toBe(openWAPilotRecipientHash('acct', 'conn', '967700000001@c.us'))
    expect(openWAPilotRecipientHash('acct', 'other-conn', '967700000001')).not.toBe(openWAPilotRecipientHash('acct', 'conn', '967700000001'))
    expect(openWAPilotRecipientHash('other-acct', 'conn', '967700000001')).not.toBe(openWAPilotRecipientHash('acct', 'conn', '967700000001'))
  })

  it('blocks absent or wrong-scope cohort before guardrail reservation and provider', async () => {
    vi.stubEnv('OPENWA_PILOT_MODE', 'enforce')
    const t = pilotSetup({ admitted: false })
    await expect(t.guarded.send({ ...request, workload: 'broadcast' })).rejects.toMatchObject({ code: 'connection_restricted' })
    expect(t.rpc).toHaveBeenCalledTimes(1)
    expect(t.rpc).toHaveBeenCalledWith('check_openwa_pilot_admission', expect.objectContaining({
      p_account_id: request.accountId,
      p_connection_id: request.connectionId,
      p_workload: 'broadcast',
      p_recipient_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }))
    expect(JSON.stringify(t.rpc.mock.calls[0])).not.toContain(request.recipient)
    expect(t.send).not.toHaveBeenCalled()
  })

  it('fails closed when pilot RPC/schema is absent or unavailable', async () => {
    vi.stubEnv('OPENWA_PILOT_MODE', 'enforce')
    const t = pilotSetup({ admitted: true, rpcError: true })
    await expect(t.guarded.send(request)).rejects.toMatchObject({ code: 'retryable_provider_failure' })
    expect(t.rpc).toHaveBeenCalledTimes(1)
    expect(t.send).not.toHaveBeenCalled()
  })

  it('admits approved workload but checks emergency stop before sending', async () => {
    vi.stubEnv('OPENWA_PILOT_MODE', 'enforce')
    const t = pilotSetup({ admitted: true })
    const result = await t.guarded.send({ ...request, workload: 'agent' })
    expect(result.providerMessageId).toBe('provider-mock-1')
    expect(t.send).toHaveBeenCalledTimes(1)
    expect(t.from).toHaveBeenCalledWith('whatsapp_connection_guardrails')
    expect(t.filters).toContainEqual(['account_id', request.accountId])
    expect(t.filters).toContainEqual(['connection_id', request.connectionId])
    expect(t.rpc.mock.calls.map(([name]) => name)).toEqual([
      'check_openwa_pilot_admission', 'reserve_openwa_guardrail_send', 'record_openwa_guardrail_outcome',
    ])
  })

  it('blocks a manual pause or open circuit, including after capacity was reserved', async () => {
    vi.stubEnv('OPENWA_PILOT_MODE', 'enforce')
    for (const options of [{ paused: true }, { circuitUntil: new Date(Date.now() + 60_000).toISOString() }, { fenceError: true }]) {
      const t = pilotSetup({ admitted: true, ...options })
      await expect(t.guarded.send(request)).rejects.toMatchObject({
        code: options.fenceError ? 'retryable_provider_failure' : 'connection_restricted',
      })
      expect(t.send).not.toHaveBeenCalled()
    }
  })

  it('revalidates cohort after pacing and blocks a mid-wait revoke without calling the provider', async () => {
    vi.stubEnv('OPENWA_PILOT_MODE', 'enforce')
    vi.useFakeTimers()
    try {
      const t = pilotSetup({ admitted: true, waitMs: 75 })
      let admissionChecks = 0
      t.rpc.mockImplementation(async (name: string) => {
        if (name === 'check_openwa_pilot_admission') return { data: { allowed: ++admissionChecks === 1 }, error: null }
        if (name === 'reserve_openwa_guardrail_send') return { data: { allowed: true, wait_ms: 75 }, error: null }
        return { data: null, error: null }
      })
      const pending = t.guarded.send(request)
      await vi.advanceTimersByTimeAsync(75)
      await expect(pending).rejects.toMatchObject({ code: 'connection_restricted' })
      expect(admissionChecks).toBe(2)
      expect(t.send).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves Meta unaffected by guarding only the OpenWA-specific transport', async () => {
    vi.stubEnv('OPENWA_PILOT_MODE', 'enforce')
    const t = pilotSetup({ admitted: true })
    expect(t.guarded.provider).toBe('openwa')
    expect(t.rpc).not.toHaveBeenCalled()
    // The provider-neutral router wraps OpenWA, not Meta; this test ensures
    // the pilot gate isn't evaluated until the OpenWA wrapper is invoked.
  })
})
