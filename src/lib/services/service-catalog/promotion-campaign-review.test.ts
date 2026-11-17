import { beforeEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({
  audience: vi.fn(), service: vi.fn(), allow: vi.fn(), isTest: vi.fn(),
}))
vi.mock('./promotion-audience', () => ({
  resolveServicePromotionAudience: stubs.audience,
}))
vi.mock('./agent-task', () => ({
  loadServicePromotionContext: stubs.service,
  promotionSnapshotName: (name: unknown) => {
    if (typeof name !== 'string' || name.includes('\n')) throw new Error('invalid name')
    return name
  },
}))
vi.mock('@/lib/ai/tasks/builder-v2', () => ({
  isAgentBuilderV2Configuration: () => true,
}))
vi.mock('@/lib/ai/tasks/test-openwa-task-admission', () => ({
  deferredTestOpenWATaskReason: stubs.allow,
}))
vi.mock('@/lib/whatsapp/transport/guardrails', () => ({
  isOpenWATestProject: stubs.isTest,
}))

import {
  assertPromotionReviewFresh, inspectServicePromotionCampaign,
  ServicePromotionReviewError,
} from './promotion-campaign-review'

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const accountId = id(1)
const serviceId = id(2)
const agentId = id(3)
const revisionId = id(4)
const connectionId = id(5)
const tagId = id(6)
const A = id(101)
const B = id(102)

function fakeDb(options: { provider?: string; template?: boolean; paused?: boolean; tenant?: string } = {}) {
  const eqs: Array<[string, string, string]> = []
  const from = vi.fn((table: string) => {
    const where = new Map<string, unknown>()
    const row = table === 'ai_agents'
      ? { id: agentId, name: 'Sales', status: 'active', published_revision_id: revisionId }
      : table === 'whatsapp_connections'
        ? { id: connectionId, display_name: 'TEST connection',
          provider: options.provider ?? 'meta_cloud',
          status: options.provider === 'openwa' ? 'ready' : 'connected',
          session_id: options.provider === 'openwa' ? 'session' : null,
          archived_at: null }
        : table === 'ai_agent_revisions'
          ? { id: revisionId, status: 'published', operational_mode: 'both',
            outreach_policy: { bindings: [{
              taskType: 'services.promotion', taskTypeVersion: 2,
              maxTargets: 3, approvalMode: 'task',
              targetScope: { requiredTagIds: [tagId], excludedTagIds: [],
                serviceIds: [serviceId], regionIds: [], domainSelector: null },
            }] } }
          : table === 'whatsapp_connection_guardrails'
            ? { manual_paused: options.paused ?? false,
              circuit_open_until: null, pilot_enabled: true } : null
    const chain = {
      select: () => chain,
      eq: (key: string, value: unknown) => {
        where.set(key, value)
        eqs.push([table, key, String(value)])
        return chain
      },
      in: () => chain,
      maybeSingle: async () => ({
        data: where.get('account_id') === (options.tenant ?? accountId) ? row : null,
        error: null,
      }),
      limit: async () => ({
        data: table === 'contacts' ? [A, B].map((id, i) => ({
          id, name: 'Customer ' + i, phone: '96770000000' + i,
          phone_normalized: '96770000000' + i,
        })) : table === 'ai_outreach_contact_controls' ? []
          : table === 'message_templates' && options.template !== false
            ? [{ id: id(99), name: 'service_promotion_v1', language: 'ar',
              status: 'APPROVED', category: 'MARKETING',
              body_text: 'مرحبًا، لدينا {{1}} متاحة.' }] : [],
        error: null,
      }),
    }
    return chain
  })
  return { db: { from } as never, from, eqs }
}
const input = { accountId, serviceId, agentId, connectionId }

beforeEach(() => {
  vi.clearAllMocks()
  stubs.isTest.mockReturnValue(true)
  stubs.allow.mockResolvedValue(null)
  stubs.audience.mockResolvedValue([A, B])
  stubs.service.mockResolvedValue({
    serviceId,
    service: { serviceId, name: 'خدمة التجربة', code: 'TEST', publicDescription: 'خدمة عامة' },
  })
})

describe('Promotion campaign approval inspection', () => {
  it('requires account-bound service/agent/provider and approved marketing template', async () => {
    const { db, eqs } = fakeDb()
    const review = await inspectServicePromotionCampaign(db, input)
    expect(review.blockers).toEqual([])
    expect(review.firstMessage.kind).toBe('template')
    expect(review.firstMessage.body).toContain('خدمة التجربة')
    expect(review.audience.ids).toEqual([A, B])
    expect(review.template?.status).toBe('APPROVED_LOCAL')
    expect(review.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(eqs).toContainEqual(['whatsapp_connections', 'account_id', accountId])
    expect(eqs).toContainEqual(['ai_agent_revisions', 'account_id', accountId])
    expect(eqs).toContainEqual(['message_templates', 'account_id', accountId])
    expect(stubs.audience).toHaveBeenCalledWith(db, {
      accountId, requiredTagIds: [tagId], excludedTagIds: [], maxContacts: 3,
    })
  })

  it('blocks missing approval and paused provider; never pretends readiness', async () => {
    const missing = await inspectServicePromotionCampaign(fakeDb({ template: false }).db, input)
    expect(missing.blockers).toContain('SERVICE_PROMOTION_APPROVED_TEMPLATE_MISSING')
    const paused = await inspectServicePromotionCampaign(fakeDb({ paused: true }).db, input)
    expect(paused.blockers).toContain('SERVICE_PROMOTION_CONNECTION_PAUSED')
  })

  it('rejects cross-tenant selected connection before audience resolution', async () => {
    const { db } = fakeDb({ tenant: id(999) })
    await expect(inspectServicePromotionCampaign(db, input))
      .rejects.toMatchObject({ code: 'SERVICE_PROMOTION_AGENT_NOT_PUBLISHED' })
    expect(stubs.audience).not.toHaveBeenCalled()
  })

  it('refuses stale/expired preview and freezes membership in its fingerprint', async () => {
    const { db } = fakeDb()
    const first = await inspectServicePromotionCampaign(db, input)
    const reviewedAt = new Date().toISOString()
    expect(() => assertPromotionReviewFresh({
      fingerprint: first.fingerprint, actualFingerprint: first.fingerprint, reviewedAt,
    })).not.toThrow()
    stubs.audience.mockResolvedValueOnce([A])
    const changed = await inspectServicePromotionCampaign(db, input)
    expect(changed.fingerprint).not.toBe(first.fingerprint)
    expect(() => assertPromotionReviewFresh({
      fingerprint: first.fingerprint, actualFingerprint: changed.fingerprint, reviewedAt,
    })).toThrow('SERVICE_PROMOTION_REVIEW_STALE')
    expect(() => assertPromotionReviewFresh({
      fingerprint: first.fingerprint, actualFingerprint: first.fingerprint,
      reviewedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    })).toThrow('SERVICE_PROMOTION_REVIEW_EXPIRED')
  })

  it('routes OpenWA to text and requires checked TEST pilot admissions', async () => {
    const { db } = fakeDb({ provider: 'openwa' })
    const safe = await inspectServicePromotionCampaign(db, input)
    expect(safe.blockers).toEqual([])
    expect(safe.firstMessage.kind).toBe('text')
    expect(safe.firstMessage.body).toContain('إيقاف')
    expect(stubs.allow).toHaveBeenCalledWith({
      db, accountId, connectionId, contactIds: [A, B],
    })
    stubs.allow.mockResolvedValueOnce('pilot_recipient_not_approved')
    const denied = await inspectServicePromotionCampaign(db, input)
    expect(denied.blockers).toContain('SERVICE_PROMOTION_PILOT_RECIPIENT_NOT_APPROVED')
  })

  it('cannot inspect invalid UUID selections', async () => {
    await expect(inspectServicePromotionCampaign(fakeDb().db, {
      ...input, connectionId: 'foreign',
    })).rejects.toBeInstanceOf(ServicePromotionReviewError)
  })
})
