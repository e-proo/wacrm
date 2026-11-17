import { beforeEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({
  authorize: vi.fn(),
  from: vi.fn(),
  audience: vi.fn(),
  unexpectedError: vi.fn((error: unknown) => { throw error }),
}))

vi.mock('@/lib/auth/account', () => ({
  requireAgentCapability: stubs.authorize,
  toErrorResponse: stubs.unexpectedError,
}))
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ from: stubs.from }),
}))
vi.mock('@/lib/services/service-catalog/promotion-audience', () => ({
  resolveServicePromotionAudience: stubs.audience,
}))
vi.mock('@/lib/ai/tasks/builder-v2', () => ({
  isAgentBuilderV2Configuration: (value: unknown) =>
    Boolean(value && typeof value === 'object' && 'bindings' in value),
}))

import { GET } from './route'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const accountId = id(1)
const serviceId = id(2)
const agentId = id(3)
const revisionId = id(4)
const tagId = id(5)
const contactId = id(6)

const url = (more = '') => new Request(
  `http://localhost/api/agent-tasks/promotion/preview?serviceId=${serviceId}&agentId=${agentId}${more}`,
)

function record(table: string) {
  const state = {
    services: { id: serviceId, name: 'TEST Service', status: 'active' },
    ai_agents: { id: agentId, name: 'Promotion Agent', status: 'active', published_revision_id: revisionId },
    ai_agent_revisions: {
      id: revisionId, status: 'published', operational_mode: 'both',
      outreach_policy: {
        bindings: [{
          taskType: 'services.promotion', taskTypeVersion: 1, maxTargets: 3,
          targetScope: { requiredTagIds: [tagId], excludedTagIds: [],
            serviceIds: [serviceId], regionIds: [], domainSelector: null },
        }],
      },
    },
  } as Record<string, unknown>
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    maybeSingle: async () => ({ data: state[table] ?? null, error: null }),
    limit: async () => ({
      data: table === 'contacts'
        ? [{ id: contactId, name: 'TEST contact', phone_normalized: '967700000001' }]
        : table === 'ai_outreach_contact_controls'
          ? [] : [],
      error: null,
    }),
  }
  return chain
}

beforeEach(() => {
  vi.clearAllMocks()
  stubs.authorize.mockResolvedValue({ accountId, userId: id(99) })
  stubs.from.mockImplementation(record)
  stubs.audience.mockResolvedValue([contactId])
})

describe('Service Promotion read-only preview API', () => {
  it('derives tenant from session, previews exact frozen cohort, never creates Task or sends', async () => {
    const res = await GET(url('&accountId=forged&actorUserId=forged'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.previewOnly).toBe(true)
    expect(body.readyForLaunch).toBe(false)
    expect(body.audience.contacts).toEqual([{
      id: contactId, name: 'TEST contact', reason: 'consent_and_transport_not_verified',
    }])
    expect(stubs.authorize).toHaveBeenCalledWith('agents.manage_tasks')
    expect(stubs.authorize).toHaveBeenCalledWith('agents.manage_outreach')
    expect(stubs.audience).toHaveBeenCalledWith(expect.anything(), {
      accountId, requiredTagIds: [tagId], excludedTagIds: [], maxContacts: 3,
    })
    expect(stubs.from).not.toHaveBeenCalledWith('ai_agent_tasks')
    expect(res.headers.get('Cache-Control')).toContain('no-store')
  })

  it('rejects malformed identifiers without a DB operation', async () => {
    const res = await GET(new Request('http://localhost/api/agent-tasks/promotion/preview?serviceId=bad&agentId=bad'))
    expect(res.status).toBe(400)
    expect(stubs.from).not.toHaveBeenCalled()
  })

  it('returns a bounded operator-visible blocker when the cohort is too large', async () => {
    stubs.audience.mockRejectedValue(new Error('SERVICE_PROMOTION_AUDIENCE_EXCEEDS_APPROVED_LIMIT'))
    const res = await GET(url())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('SERVICE_PROMOTION_AUDIENCE_EXCEEDS_APPROVED_LIMIT')
  })

  it('rejects unauthorized callers without any database query', async () => {
    stubs.authorize.mockRejectedValue(new Error('FORBIDDEN'))
    await expect(GET(url())).rejects.toThrow('FORBIDDEN')
    expect(stubs.from).not.toHaveBeenCalled()
  })
})
