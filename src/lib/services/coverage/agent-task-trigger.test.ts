import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COVERAGE_SOURCING_TRIGGER_HANDLER_V2 } from './agent-task-trigger'
import type { AgentTaskTriggerFiring } from '@/lib/ai/tasks/triggers'

const mocks=vi.hoisted(()=>({start:vi.fn()}))
vi.mock('./agent-task-service',()=>({ startCoverageSourcingTask:mocks.start }))

const account='11111111-1111-4111-8111-111111111111'
const request='22222222-2222-4222-8222-222222222222'
const agent='33333333-3333-4333-8333-333333333333'
const conn='44444444-4444-4444-8444-444444444444'
const actor='55555555-5555-4555-8555-555555555555'
const contact='66666666-6666-4666-8666-666666666666'
const base:AgentTaskTriggerFiring={
 firingId:'firing-1',accountId:account,triggerId:'trigger-1',
 taskType:'coverage.sourcing',taskTypeVersion:2,agentId:agent,
 triggerKind:'business_event',
 config:{coverageRequestId:request,whatsappConnectionId:conn,selectedContactIds:[contact]},
 filters:{subject_type:'coverage_request',subject_id:request},
 createdBy:actor,sourceKey:'event-1',scheduledFor:null,attempts:1,
 policyVersion:1,overlapPolicy:'skip',approvedRevisionId:actor,
 businessEvent:{id:'event-1',eventType:'coverage.request.activated',
 eventVersion:1,subjectType:'coverage_request',subjectId:request,
 correlationId:null,causationId:null,createdAt:new Date().toISOString(),payload:{account_id:account}},
}
describe('SCH-3 coverage pinned event boundaries',()=>{
 beforeEach(()=>{vi.clearAllMocks();mocks.start.mockResolvedValue({taskId:'task-1',created:true})})
 it('preserves the approved request, tenant, connection and explicit recipients',async()=>{
  await COVERAGE_SOURCING_TRIGGER_HANDLER_V2.start(base)
  expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
    accountId:account,coverageRequestId:request,
    whatsappConnectionId:conn,selectedContactIds:[contact],
    approvedRevisionId:actor,requestedTaskTypeVersion:2,
  }))
 })
 it('rejects a foreign source, mismatched event filter or tenant without Task creation',async()=>{
  for(const firing of [
    {...base,config:{...base.config,coverageRequestId:account}},
    {...base,filters:{subject_type:'coverage_request',subject_id:account}},
    {...base,businessEvent:{...base.businessEvent!,payload:{account_id:actor}}},
    {...base,businessEvent:{...base.businessEvent!,subjectId:account}},
    {...base,config:{...base.config,whatsappConnectionId:undefined}},
  ]){
    await expect(COVERAGE_SOURCING_TRIGGER_HANDLER_V2.start(firing as AgentTaskTriggerFiring))
      .rejects.toThrow()
  }
  expect(mocks.start).not.toHaveBeenCalled()
 })
 it('rejects implicit or malformed recipients',async()=>{
  await expect(COVERAGE_SOURCING_TRIGGER_HANDLER_V2.start({
    ...base,config:{...base.config,selectedContactIds:[contact,contact]},
  })).rejects.toThrow('COVERAGE_SOURCING_SCHEDULE_CONTACTS_INVALID')
  expect(mocks.start).not.toHaveBeenCalled()
 })
})
