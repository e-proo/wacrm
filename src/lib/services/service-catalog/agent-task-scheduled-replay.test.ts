import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn()}))
vi.mock('@/lib/ai/admin-client',()=>({
  supabaseAdmin:()=>({from:mocks.from,rpc:mocks.rpc}),
}))
vi.mock('@/lib/whatsapp/transport/guardrails',()=>({
  isOpenWATestProject:()=>true,
}))

import { startServicePromotionTask, promotionScheduledTaskIdentity } from './agent-task-service'

const account='11111111-1111-4111-8111-111111111111'
const service='22222222-2222-4222-8222-222222222222'
const agent='33333333-3333-4333-8333-333333333333'
const revision='44444444-4444-4444-8444-444444444444'
const actor='55555555-5555-4555-8555-555555555555'
const connection='66666666-6666-4666-8666-666666666666'
const contact='77777777-7777-4777-8777-777777777777'
const triggerRef='schedule:rule-1:occurrence-1'
const sourceKey='occurrence-1'
const when='2026-11-18T00:00:00.000Z'
const frozen=()=>({
 schemaVersion:1 as const,serviceId:service,agentId:agent,approvedRevisionId:revision,
 approvedBy:actor,connectionId:connection,provider:'meta_cloud' as const,
 fingerprint:'a'.repeat(64),reviewedAt:when,approvedAt:when,
 frozenContactIds:[contact],consentAcknowledged:true as const,
 approvalAcknowledged:true as const,recurringAcknowledged:true,
})
const input=()=>({
 accountId:account,serviceId:service,agentId:agent,actorUserId:actor,
 approvedRevisionId:revision,
 review:{
  connectionId:connection,fingerprint:'a'.repeat(64),reviewedAt:when,
  submissionId:'88888888-8888-4888-8888-888888888888',
  consentAcknowledged:true,approvalAcknowledged:true,scheduledPolicy:frozen(),
 },
 trigger:{triggerType:'scheduled' as const,triggerRef,sourceKey},
})
function existingTask(ref=triggerRef){
 mocks.from.mockImplementation((table:string)=>{
  if(table!=='ai_agent_tasks')throw new Error('Unexpected table after replay: '+table)
  return {
   select(){return this},eq(){return this},
   async maybeSingle(){return {data:{
     id:'replay-task',agent_id:agent,agent_revision_id:revision,
     trigger_ref:ref,task_type_version:2,
   },error:null}},
  }
 })
}
describe('SCH-3: promotion scheduled V2 no-send replay',()=>{
 beforeEach(()=>{
  vi.clearAllMocks();vi.useFakeTimers();vi.setSystemTime(when)
  process.env.WACRM_SERVICE_PROMOTION_PILOT_ALLOW_LIVE='1'
  existingTask()
 })
 afterEach(()=>{
  vi.useRealTimers();delete process.env.WACRM_SERVICE_PROMOTION_PILOT_ALLOW_LIVE
 })
 it('two workers recovering same firing reuse exact Task without new create/outbound',async()=>{
  const [a,b]=await Promise.all([
    startServicePromotionTask(input()),startServicePromotionTask(input()),
  ])
  expect(a).toMatchObject({taskId:'replay-task',created:false,revisionId:revision})
  expect(b).toMatchObject({taskId:'replay-task',created:false,revisionId:revision})
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.from).toHaveBeenCalledTimes(2)
 })
 it('rejects a replay bound to another triggering schedule',async()=>{
  existingTask('schedule:another:occurrence')
  await expect(startServicePromotionTask(input())).rejects.toMatchObject({
    code:'SERVICE_PROMOTION_SCHEDULE_REPLAY_SCOPE_CONFLICT',
  })
  expect(mocks.rpc).not.toHaveBeenCalled()
 })
 it('denies changed approval and disabled pilot before any Task creation',async()=>{
  const changed=input()
  changed.review.scheduledPolicy.fingerprint='b'.repeat(64)
  await expect(startServicePromotionTask(changed)).rejects.toMatchObject({
    code:'SERVICE_PROMOTION_SCHEDULE_REVIEW_SCOPE_CONFLICT',
  })
  expect(mocks.rpc).not.toHaveBeenCalled()
  vi.clearAllMocks()
  delete process.env.WACRM_SERVICE_PROMOTION_PILOT_ALLOW_LIVE
  await expect(startServicePromotionTask(input())).rejects.toMatchObject({
    code:'SERVICE_PROMOTION_LIVE_ACCEPTANCE_NOT_AUTHORIZED',
  })
  expect(mocks.from).not.toHaveBeenCalled()
 })
 it('derives unique stable idempotency identity for each firing and tenant',()=>{
  const common={accountId:account,serviceId:service,agentId:agent,
    revisionId:revision,sourceKey}
  expect(promotionScheduledTaskIdentity(common)).toBe(promotionScheduledTaskIdentity(common))
  expect(promotionScheduledTaskIdentity(common)).not.toBe(
    promotionScheduledTaskIdentity({...common,sourceKey:sourceKey+'-2'}))
  expect(promotionScheduledTaskIdentity(common)).not.toBe(
    promotionScheduledTaskIdentity({...common,accountId:contact}))
 })
})
