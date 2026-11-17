import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks=vi.hoisted(()=>({
  isTest:vi.fn(),requireAgentCapability:vi.fn(),rpc:vi.fn(),
  toErrorResponse:vi.fn(),
}))
vi.mock('@/lib/whatsapp/transport/guardrails',()=>({
  isOpenWATestProject:mocks.isTest,
}))
vi.mock('@/lib/auth/account',()=>({
  requireAgentCapability:mocks.requireAgentCapability,
  toErrorResponse:mocks.toErrorResponse,
}))
vi.mock('@/lib/ai/admin-client',()=>({
  supabaseAdmin:()=>({rpc:mocks.rpc}),
}))
import { GET } from './route'
const account='11111111-1111-4111-8111-111111111111'

beforeEach(()=>{
 vi.clearAllMocks()
 mocks.isTest.mockReturnValue(true)
 mocks.requireAgentCapability.mockResolvedValue({accountId:account})
 mocks.rpc.mockResolvedValue({data:{
  enabledSchedules:1,backlog:8,backlogCap:10,
  dead:1,staleClaims:1,dueLagSeconds:320,backlogLagSeconds:0,
  taskWorkerEnabled:true,
  runnerConsecutiveFailures:2,runnerLastSucceededAt:'2026-11-18T00:00:00Z',
  observedAt:'2026-11-18T00:16:00Z',
 },error:null})
 mocks.toErrorResponse.mockImplementation(()=>new Response('Forbidden',{status:403}))
})
describe('SCH-4 tenant-scoped scheduler health',()=>{
 it('rejects non-TEST environments before reading any account data',async()=>{
  mocks.isTest.mockReturnValue(false)
  expect((await GET()).status).toBe(403)
  expect(mocks.requireAgentCapability).not.toHaveBeenCalled()
  expect(mocks.rpc).not.toHaveBeenCalled()
 })
 it('rejects unauthorized members without using service-role SQL',async()=>{
  mocks.requireAgentCapability.mockRejectedValueOnce(new Error('Forbidden'))
  expect((await GET()).status).toBe(403)
  expect(mocks.rpc).not.toHaveBeenCalled()
 })
 it('uses authenticated account ID rather than caller-provided tenant',async()=>{
  const res=await GET()
  expect(res.status).toBe(200)
  expect(res.headers.get('Cache-Control')).toContain('no-store')
  expect(mocks.requireAgentCapability).toHaveBeenCalledWith('agents.manage_tasks')
  expect(mocks.rpc).toHaveBeenCalledWith('inspect_agent_task_schedule_health',{
   p_account_id:account,
  })
  const result=await res.json()
  expect(result.alerts).toEqual([
    'STALE_CLAIMS','DEAD_FIRINGS','BACKLOG_NEAR_CAP',
    'SCHEDULER_LAG','WORKER_ERRORS','WORKER_HEARTBEAT_STALE',
  ])
 })
 it('does not claim stale worker outage for a paused or empty account',async()=>{
  mocks.rpc.mockResolvedValueOnce({data:{
    enabledSchedules:0,backlog:0,backlogCap:100,
    dead:0,staleClaims:0,dueLagSeconds:0,backlogLagSeconds:0,
    taskWorkerEnabled:false,
    runnerConsecutiveFailures:0,runnerLastSucceededAt:null,
    observedAt:'2026-11-18T00:16:00Z',
  },error:null})
  expect((await(await GET()).json()).alerts).toEqual([])
 })
})
