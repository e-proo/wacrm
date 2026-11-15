import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const stubs = vi.hoisted(() => ({
  resolve: vi.fn(),
  hash: vi.fn((_a: string, _b: string, r: string) => 'hash:' + r),
  testProject: vi.fn(() => true),
}))
vi.mock('@/lib/whatsapp/transport/openwa/pilot-recipient', () => ({
  resolveOpenWAPilotRecipientForGrant: stubs.resolve,
}))
vi.mock('@/lib/whatsapp/transport/guardrails', () => ({
  isOpenWATestProject: stubs.testProject,
  openWAPilotRecipientHash: stubs.hash,
}))

import { deferredTestOpenWATaskReason } from './test-openwa-task-admission'
const accountId = 'acc-test'
const connectionId = 'conn-test'
const contactId = 'crm-target-a'
const rec = '967700000001@c.us'

function fakeDb(options: {
  paused?: boolean
  pilot?: boolean
  granted?: boolean
  inbound?: boolean
  consentBasis?: 'verified_inbound' | 'phone_call'
  provider?: string
  phone?: string
  connectionStatus?: string
} = {}) {
  const tables: string[] = []
  const rpc = vi.fn()
  const from = vi.fn((table: string) => {
    tables.push(table)
    const query = {
      select: () => query, eq: () => query, gt: () => query,
      gte: () => query, in: () => query, limit: async () => {
        switch (table) {
          case 'contacts': return {data:[{id:contactId,phone:options.phone ?? '967700000001'}],error:null}
          case 'messages': return {data:options.inbound === false ? [] : [{id:'inbound'}],error:null}
          case 'whatsapp_openwa_pilot_allowlist':
            return {data: options.granted === false ? [] : [{
              recipient_hash:'hash:' + rec,
              consent_basis: options.consentBasis ?? 'verified_inbound',
              consent_attested_at: options.consentBasis === 'phone_call'
                ? '2026-11-15T12:00:00Z' : null,
            }],error:null}
          default: throw Error('unexpected limit table '+table)
        }
      },
      maybeSingle: async () => {
        if (table === 'whatsapp_connections') return {
          data:{provider: options.provider ?? 'openwa',status:options.connectionStatus ?? 'ready',archived_at:null},error:null,
        }
        if (table === 'whatsapp_connection_guardrails') return {
          data:{manual_paused: options.paused ?? false,
            pilot_enabled: options.pilot ?? true,circuit_open_until:null},error:null,
        }
        throw Error('unexpected maybeSingle table '+table)
      },
    }
    return query
  })
  return {db:{from,rpc} as unknown as SupabaseClient,from,tables,rpc}
}

beforeEach(() => {
  vi.clearAllMocks()
  stubs.testProject.mockReturnValue(true)
  stubs.resolve.mockResolvedValue({recipient:rec,source:'verified_inbound_chat'})
})

describe('TEST Agent Task preclaim OpenWA pilot readiness', () => {
  it('does not hold Meta or non-TEST tasks', async () => {
    const t = fakeDb({provider:'meta_cloud'})
    expect(await deferredTestOpenWATaskReason({
      db:t.db,accountId,connectionId,contactIds:[contactId],
    })).toBeNull()
    expect(t.tables).toEqual(['whatsapp_connections'])
    stubs.testProject.mockReturnValue(false)
    expect(await deferredTestOpenWATaskReason({
      db:t.db,accountId,connectionId,contactIds:[contactId],
    })).toBeNull()
    expect(t.tables).toEqual(['whatsapp_connections'])
  })

  it('defers while the test session is stopped instead of consuming a Run', async () => {
    const t = fakeDb({paused:true})
    expect(await deferredTestOpenWATaskReason({
      db:t.db,accountId,connectionId,contactIds:[contactId],
    })).toBe('connection_paused')
    expect(t.tables).not.toContain('messages')
    expect(t.rpc).not.toHaveBeenCalled()
  })

  it('defers an unapproved or unverified number; never calls transport', async () => {
    const t = fakeDb({granted:false})
    expect(await deferredTestOpenWATaskReason({
      db:t.db,accountId,connectionId,contactIds:[contactId],
    })).toBe('pilot_recipient_not_approved')
    const missingInbound = fakeDb({inbound:false})
    expect(await deferredTestOpenWATaskReason({
      db:missingInbound.db,accountId,connectionId,contactIds:[contactId],
    })).toBe('pilot_recipient_not_approved')
    expect(t.rpc).not.toHaveBeenCalled()
  })

  it('proceeds only when the exact chat has active Agent approval', async () => {
    const t = fakeDb()
    expect(await deferredTestOpenWATaskReason({
      db:t.db,accountId,connectionId,contactIds:[contactId],
    })).toBeNull()
    expect(stubs.hash).toHaveBeenCalledWith(accountId,connectionId,rec)
    expect(t.tables).toContain('whatsapp_openwa_pilot_allowlist')
    expect(t.rpc).not.toHaveBeenCalled()
  })

  it('allows an explicitly approved telephone opt-in without any recent WhatsApp inbound', async () => {
    stubs.resolve.mockResolvedValue({recipient:rec,source:'phone_without_inbound'})
    const approved = fakeDb({inbound:false,consentBasis:'phone_call'})
    expect(await deferredTestOpenWATaskReason({
      db:approved.db,accountId,connectionId,contactIds:[contactId],
    })).toBeNull()
    expect(approved.tables).not.toContain('messages')
    const noApproval = fakeDb({inbound:false,granted:false})
    expect(await deferredTestOpenWATaskReason({
      db:noApproval.db,accountId,connectionId,contactIds:[contactId],
    })).toBe('pilot_recipient_not_approved')
    const inboundBasisOnly = fakeDb({inbound:false,consentBasis:'verified_inbound'})
    expect(await deferredTestOpenWATaskReason({
      db:inboundBasisOnly.db,accountId,connectionId,contactIds:[contactId],
    })).toBe('pilot_recipient_not_approved')
  })

  it('lets explicit TEST normal mode proceed, still subject to transport gates', async () => {
    const t = fakeDb({pilot:false})
    expect(await deferredTestOpenWATaskReason({
      db:t.db,accountId,connectionId,contactIds:[contactId],
    })).toBeNull()
    expect(t.tables).not.toContain('whatsapp_openwa_pilot_allowlist')
  })
})
