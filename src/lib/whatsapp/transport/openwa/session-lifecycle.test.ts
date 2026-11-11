import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('./credentials', () => ({ resolveOpenWAClient: h.client }))

import { canApplyOpenWAStateTransition, normalizeOpenWAConnectionState, refreshOpenWAConnectionStatus } from './session-lifecycle'

describe('OpenWA session lifecycle', () => {
  it('normalizes provider-specific status aliases', () => {
    expect(normalizeOpenWAConnectionState('created')).toBe('creating')
    expect(normalizeOpenWAConnectionState('initializing')).toBe('authenticating')
    expect(normalizeOpenWAConnectionState('action_required')).toBe('failed')
    expect(normalizeOpenWAConnectionState('qr_ready')).toBe('waiting_qr')
    expect(normalizeOpenWAConnectionState('authenticated')).toBe('connected')
    expect(normalizeOpenWAConnectionState('online')).toBe('ready')
    expect(normalizeOpenWAConnectionState('banned')).toBe('restricted')
    expect(normalizeOpenWAConnectionState('unknown-provider-state')).toBe('failed')
  })

  it('prevents stale lifecycle updates from reviving terminal states', () => {
    expect(canApplyOpenWAStateTransition('restricted', 'ready')).toBe(false)
    expect(canApplyOpenWAStateTransition('logged_out', 'reconnecting')).toBe(false)
    expect(canApplyOpenWAStateTransition('ready', 'reconnecting')).toBe(true)
    expect(canApplyOpenWAStateTransition('failed', 'authenticating')).toBe(true)
    expect(canApplyOpenWAStateTransition('authenticating', 'waiting_qr')).toBe(true)
    expect(canApplyOpenWAStateTransition('reconnecting', 'waiting_qr')).toBe(true)
    expect(canApplyOpenWAStateTransition('reconnecting', 'ready')).toBe(true)
  })
})

function connectionFixture(status: string, metadata: Record<string, unknown>, remote: Record<string, unknown>) {
  const row = {
    id: 'connection-1', account_id: 'account-1', session_id: 'session-1',
    status, phone_identity: null, provider_metadata: metadata,
  }
  const patches: Array<Record<string, unknown>> = []
  const filters: Array<[string, unknown]> = []
  const selectQuery = {
    eq: (_key: string, _value: unknown) => selectQuery,
    is: (_key: string, _value: unknown) => selectQuery,
    maybeSingle: async () => ({ data: row, error: null }),
  }
  const updateQuery = {
    eq: (key: string, value: unknown) => { filters.push([key, value]); return updateQuery },
    then: (resolve: (value: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve),
  }
  const db = {
    from: vi.fn(() => ({
      select: vi.fn(() => selectQuery),
      update: vi.fn((patch: Record<string, unknown>) => { patches.push(patch); return updateQuery }),
    })),
  } as unknown as SupabaseClient
  h.client.mockResolvedValue({ client: { getSessionStatus: vi.fn().mockResolvedValue(remote) } })
  return { db, patches, filters }
}

describe('OpenWA verified startup reconciliation', () => {
  it('recovers a failed ambiguous start only after a matching ready gateway session is fetched', async () => {
    const { db, patches, filters } = connectionFixture('failed', {
      onboarding_stage: 'gateway_start', onboarding_failure_code: 'ambiguous_outcome',
      onboarding_reconciliation_required: true, customer_note: 'keep',
    }, { sessionId: 'session-1', status: 'ready', phoneIdentity: '967700000000' })
    expect(await refreshOpenWAConnectionStatus(db, 'account-1', 'connection-1')).toMatchObject({ status: 'ready' })
    expect(patches).toEqual([expect.objectContaining({
      status: 'ready', phone_identity: '967700000000', provider_metadata: { customer_note: 'keep' },
    })])
    expect(filters).toContainEqual(['session_id', 'session-1'])
  })

  it('also clears stale onboarding warnings for an already-ready session', async () => {
    const { db, patches } = connectionFixture('ready', {
      onboarding_stage: 'gateway_start', onboarding_failure_code: 'ambiguous_outcome',
      onboarding_reconciliation_required: true, retained: 7,
    }, { sessionId: 'session-1', status: 'ready' })
    expect((await refreshOpenWAConnectionStatus(db, 'account-1', 'connection-1')).status).toBe('ready')
    expect(patches[0].provider_metadata).toEqual({ retained: 7 })
  })

  it('never clears uncertainty or revives a failed session without verified recovery', async () => {
    const { db, patches } = connectionFixture('failed', {}, { sessionId: 'session-1', status: 'ready' })
    expect((await refreshOpenWAConnectionStatus(db, 'account-1', 'connection-1')).status).toBe('failed')
    expect(patches).toHaveLength(0)
  })

  it('refuses a mismatched gateway session identity', async () => {
    const { db, patches } = connectionFixture('failed', { onboarding_reconciliation_required: true }, {
      sessionId: 'another-session', status: 'ready',
    })
    await expect(refreshOpenWAConnectionStatus(db, 'account-1', 'connection-1')).rejects.toMatchObject({ code: 'connection_restricted' })
    expect(patches).toHaveLength(0)
  })

  it('does not resurrect restricted sessions even with old onboarding metadata', async () => {
    const { db, patches } = connectionFixture('restricted', { onboarding_reconciliation_required: true }, {
      sessionId: 'session-1', status: 'ready',
    })
    expect((await refreshOpenWAConnectionStatus(db, 'account-1', 'connection-1')).status).toBe('restricted')
    expect(patches).toHaveLength(0)
  })
})
