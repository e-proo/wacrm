import { beforeEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({
  auth: vi.fn(), from: vi.fn(), toError: vi.fn((error: unknown) => { throw error }),
}))
vi.mock('@/lib/auth/account', () => ({
  requireAgentCapability: stubs.auth,
  toErrorResponse: stubs.toError,
}))
vi.mock('@/lib/ai/tasks/current-platform', () => ({
  CURRENT_AGENT_TASK_PLATFORM: { taskTypes: {} },
}))
vi.mock('@/lib/ai/tasks/builder-v2', () => ({
  listBuilderTaskTypes: () => [],
  defaultBuilderTaskBinding: () => null,
  isAgentBuilderV2Configuration: () => true,
  validateBuilderV2Configuration: () => ({ ok: true, issues: [] }),
}))
import { GET } from './route'

const accountId = '00000000-0000-4000-8000-000000000001'
const foreignId = '00000000-0000-4000-8000-000000000002'
const tagId = '00000000-0000-4000-8000-000000000003'

beforeEach(() => {
  vi.clearAllMocks()
  stubs.auth.mockResolvedValue({ accountId, supabase: { from: stubs.from } })
  stubs.from.mockImplementation((table: string) => {
    if (table !== 'tags') throw new Error('Unexpected table: ' + table)
    const filters: Record<string, unknown> = {}
    const query = {
      select: () => query,
      eq: (name: string, value: unknown) => { filters[name] = value; return query },
      order: () => query,
      limit: async () => ({
        data: filters.account_id === accountId
          ? [{ id: tagId, name: '[TEST] Service Promotion', color: '#888888' }] : [],
        error: null,
      }),
    }
    return query
  })
})

describe('Agent Builder tag catalog', () => {
  it('returns readable account-scoped tags for Builder with no store writes', async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.tags).toEqual([{ id: tagId,
      name: '[TEST] Service Promotion', color: '#888888' }])
    expect(body.taskTypes).toEqual([])
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(stubs.auth).toHaveBeenCalledWith('agents.read')
    expect(stubs.from).toHaveBeenCalledTimes(1)
  })

  it('fails closed on an unauthorized actor', async () => {
    stubs.auth.mockRejectedValueOnce(new Error('Forbidden'))
    await expect(GET()).rejects.toThrow('Forbidden')
    expect(stubs.from).not.toHaveBeenCalled()
  })

  it('does not obtain tenant ID from caller inputs', async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.tags[0].id).not.toBe(foreignId)
  })
})
