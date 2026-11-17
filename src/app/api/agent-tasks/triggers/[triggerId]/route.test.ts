import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAgentCapability: vi.fn(),
  toErrorResponse: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  isOpenWATestProject: vi.fn(),
}))
vi.mock('@/lib/auth/account', () => ({
  requireAgentCapability: mocks.requireAgentCapability,
  toErrorResponse: mocks.toErrorResponse,
}))
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: mocks.rpc, from: mocks.from }),
}))
vi.mock('@/lib/whatsapp/transport/guardrails', () => ({
  isOpenWATestProject: mocks.isOpenWATestProject,
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response('', { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}))

import { PATCH, DELETE } from './route'

const accountId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const agentId = '33333333-3333-4333-8333-333333333333'
const revisionId = '44444444-4444-4444-8444-444444444444'
const triggerId = '55555555-5555-4555-8555-555555555555'

function patch(data: unknown) {
  return PATCH(new Request('http://localhost/api/agent-tasks/triggers/' + triggerId, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  }), { params: Promise.resolve({ triggerId }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.WACRM_AGENT_TASK_SCHEDULING_ENABLE_TEST
  mocks.requireAgentCapability.mockResolvedValue({ accountId, userId })
  mocks.rpc.mockResolvedValue({ data: true, error: null })
  mocks.isOpenWATestProject.mockReturnValue(true)
  mocks.from.mockImplementation((table: string) => ({
    select() { return this }, eq() { return this },
    async maybeSingle() {
      if (table === 'ai_agent_task_triggers') return {
        data: { id: triggerId, status: 'paused',
          approved_revision_id: revisionId, agent_id: agentId }, error: null,
      }
      return { data: { id: agentId, status: 'active',
        published_revision_id: revisionId }, error: null }
    },
  }))
})

describe('SCH-2 tenant-scoped, no-surprise scheduler controls', () => {
  it('pauses using account-scoped existing RPC without touching WhatsApp', async () => {
    const result = await patch({ status: 'paused' })
    expect(result.status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('set_reviewed_agent_task_trigger_status', {
      p_account_id: accountId, p_trigger_id: triggerId, p_status: 'paused',
      p_actor_user_id: userId,
    })
  })

  it('refuses enabling without separate TEST gate even if actor is admin', async () => {
    const result = await patch({ status: 'enabled', confirmEnable: true })
    expect(result.status).toBe(409)
    expect((await result.json()).code).toBe('SCHEDULE_LIVE_ENABLE_NOT_AUTHORIZED')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('requires owner publish permission plus reviewed revision to enable', async () => {
    process.env.WACRM_AGENT_TASK_SCHEDULING_ENABLE_TEST = '1'
    mocks.requireAgentCapability.mockResolvedValue({ accountId, userId })
    const result = await patch({ status: 'enabled', confirmEnable: true })
    expect(result.status).toBe(200)
    expect(mocks.requireAgentCapability).toHaveBeenCalledWith('agents.publish')
    expect(mocks.rpc).toHaveBeenCalledWith('set_reviewed_agent_task_trigger_status',
      expect.objectContaining({ p_account_id: accountId, p_status: 'enabled' }))
    delete process.env.WACRM_AGENT_TASK_SCHEDULING_ENABLE_TEST
  })

  it('rejects a foreign trigger before any privileged RPC', async () => {
    mocks.from.mockImplementation(() => ({
      select() { return this }, eq() { return this },
      async maybeSingle() { return { data: null, error: null } },
    }))
    const result = await patch({ status: 'paused' })
    expect(result.status).toBe(404)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})

describe('SCH-2 pause-first policy edit and cancellation API', () => {
 beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireAgentCapability.mockResolvedValue({accountId,userId})
  mocks.from.mockImplementation(() => ({
   select(){return this},eq(){return this},
   async maybeSingle(){return {data:{id:triggerId,status:'paused',agent_id:agentId,
     approved_revision_id:revisionId},error:null}},
  }))
  mocks.rpc.mockResolvedValue({data:{updated:true,policy_version:2,skipped_firings:1},error:null})
 })
 it('uses tenant-scoped CAS and never trusts client accountId',async()=>{
  const res=await patch({action:'edit',expectedPolicyVersion:1,scheduleKind:'recurring',
    nextFireAt:new Date(Date.now()+86400000).toISOString(),intervalMinutes:120,
    overlapPolicy:'defer',accountId:'foreign'})
  expect(res.status).toBe(200)
  expect(mocks.rpc).toHaveBeenCalledWith('update_reviewed_agent_task_trigger_policy',
    expect.objectContaining({p_account_id:accountId,p_actor_user_id:userId,
      p_expected_policy_version:1,p_interval_minutes:120,p_overlap_policy:'defer'}))
  expect((await res.json()).tasksUntouched).toBe(true)
 })
 it('rejects an edit while claim is active',async()=>{
  mocks.rpc.mockResolvedValue({data:{updated:false,reason:'CLAIM_IN_FLIGHT'},error:null})
  const res=await patch({action:'edit',expectedPolicyVersion:1,scheduleKind:null,
    nextFireAt:null,intervalMinutes:null,overlapPolicy:'skip'})
  expect(res.status).toBe(409)
  expect((await res.json()).code).toBe('CLAIM_IN_FLIGHT')
 })
 it('requires explicit cancellation and preserves Tasks',async()=>{
  const request=(payload:unknown)=>DELETE(new Request('http://localhost/schedules',{
    method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),
  }),{params:Promise.resolve({triggerId})})
  expect((await request({expectedPolicyVersion:1})).status).toBe(400)
  expect(mocks.rpc).not.toHaveBeenCalled()
  mocks.rpc.mockResolvedValue({data:{cancelled:true,skipped_firings:2,
    linked_tasks_untouched:1},error:null})
  const res=await request({expectedPolicyVersion:1,confirmCancel:true,accountId:'foreign'})
  expect(res.status).toBe(200)
  expect(mocks.rpc).toHaveBeenCalledWith('cancel_reviewed_agent_task_trigger',{
    p_account_id:accountId,p_trigger_id:triggerId,p_actor_user_id:userId,
    p_expected_policy_version:1,
  })
  expect(await res.json()).toMatchObject({tasksUntouched:true,status:'cancelled',
    skippedFirings:2,linkedTasksUntouched:1})
 })
 it('refuses editing enabled or cancelled policies',async()=>{
  for(const status of ['enabled','cancelled']){
    mocks.from.mockImplementation(() => ({
      select(){return this},eq(){return this},
      async maybeSingle(){return {data:{id:triggerId,status},error:null}},
    }))
    const res=await patch({action:'edit',expectedPolicyVersion:1,scheduleKind:null,
      nextFireAt:null,intervalMinutes:null,overlapPolicy:'skip'})
    expect(res.status).toBe(409)
  }
  expect(mocks.rpc).not.toHaveBeenCalled()
 })
})
