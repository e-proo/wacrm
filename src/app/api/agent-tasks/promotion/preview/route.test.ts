import { beforeEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({
  auth: vi.fn(), inspect: vi.fn(),
  toError: vi.fn((error: unknown) => { throw error }),
  from: vi.fn(),
}))
vi.mock('@/lib/auth/account', () => ({
  requireAgentCapability: stubs.auth,
  toErrorResponse: stubs.toError,
}))
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ from: stubs.from }),
}))
vi.mock('@/lib/services/service-catalog/promotion-campaign-review', () => ({
  inspectServicePromotionCampaign: stubs.inspect,
  ServicePromotionReviewError: class ServicePromotionReviewError extends Error {
    status = 409
    constructor(public readonly code: string) { super(code) }
  },
}))
import { GET } from './route'

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const accountId = id(1)
const serviceId = id(2)
const agentId = id(3)
const connectionId = id(4)
const contactId = id(5)
function url(args = '') {
  return new Request('http://localhost/api/agent-tasks/promotion/preview?serviceId=' +
    serviceId + '&agentId=' + agentId + '&connectionId=' + connectionId + args)
}
beforeEach(() => {
  vi.clearAllMocks()
  stubs.auth.mockResolvedValue({ accountId, userId: id(99) })
  stubs.inspect.mockResolvedValue({
    service: { id: serviceId, name: 'TEST', publicDescription: 'Public' },
    agent: { id: agentId, name: 'Agent', revisionId: id(77) },
    connection: { id: connectionId, name: 'TEST Meta', provider: 'meta_cloud' },
    audience: {
      ids: [contactId],
      contacts: [{ id: contactId, name: 'Customer', phone: '967700000001', reason: null }],
      count: 1, max: 3, requiredTags: [id(12)], excludedTags: [],
    },
    template: { id: id(99), name: 'service_promotion_v1',
      language: 'ar', status: 'APPROVED_LOCAL' },
    firstMessage: { kind: 'template', body: 'مرحبًا {{1}}' },
    blockers: [],
    fingerprint: 'e'.repeat(64),
    binding: {},
  })
})

describe('Promotion preview read-only, scoped API', () => {
  it('requires both admin capabilities and resolves tenant only from session', async () => {
    const response = await GET(url('&accountId=forged&contactIds=forged'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.previewOnly).toBe(true)
    expect(body.readyForApproval).toBe(true)
    expect(body.readyForLaunch).toBe(false)
    expect(body.audience.contacts).toHaveLength(1)
    expect(body.connection.id).toBe(connectionId)
    expect(body.fingerprint).toHaveLength(64)
    expect(stubs.inspect).toHaveBeenCalledWith(expect.anything(), {
      accountId, agentId, serviceId, connectionId,
    })
    expect(stubs.auth).toHaveBeenCalledWith('agents.manage_tasks')
    expect(stubs.auth).toHaveBeenCalledWith('agents.manage_outreach')
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(stubs.from).not.toHaveBeenCalled()
  })

  it('does not query DB on malformed or missing selection', async () => {
    const response = await GET(new Request(
      'http://localhost/api/agent-tasks/promotion/preview?serviceId=bad&agentId=bad',
    ))
    expect(response.status).toBe(400)
    expect(stubs.inspect).not.toHaveBeenCalled()
  })

  it('shows blockers and NEVER marks a blocked campaign launch ready', async () => {
    const safe = await stubs.inspect({})
    stubs.inspect.mockResolvedValueOnce({
      ...safe,
      blockers: ['SERVICE_PROMOTION_CONTACT_BLOCKED'],
    })
    const response = await GET(url())
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.readyForApproval).toBe(false)
    expect(body.readyForLaunch).toBe(false)
    expect(body.blockers).toEqual(['SERVICE_PROMOTION_CONTACT_BLOCKED'])
  })

  it('rejects unauthorized callers before running the campaign inspector', async () => {
    stubs.auth.mockRejectedValueOnce(new Error('FORBIDDEN'))
    await expect(GET(url())).rejects.toThrow('FORBIDDEN')
    expect(stubs.inspect).not.toHaveBeenCalled()
  })
})
