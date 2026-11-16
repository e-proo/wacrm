import { describe,expect,it } from 'vitest'
import { isVerifiedAgentTaskBusinessOutcome } from './business-event-delivery-workload'

const event = { event_type:'coverage.offer.approved',subject_id:'offer',correlation_id:'cr',
  contact_id:'contact',conversation_id:'conversation' }
const change = {id:'cr',status:'executed',action_key:'coverage.offer.create',
  execution_result:{offer:{id:'offer'}}, proposed_payload:{
    source_task_id:'task', source_task_target_id:'target',
    contact_id:'contact',conversation_id:'conversation'} }
const task = {task_type:'coverage.sourcing',task_type_version:2}
const target = {task_id:'task',contact_id:'contact',conversation_id:'conversation'}
const supplier = {task_id:'task',task_target_id:'target',contact_id:'contact',
  conversation_id:'conversation',change_request_id:'cr',stage:'submitted'}
const verified = {event,change,task,target,supplier}
describe('verified task-owned customer outcome workload',()=>{
  it('allows only an exact executed supplier-task offer to use Agent consent',()=>{
    expect(isVerifiedAgentTaskBusinessOutcome(verified)).toBe(true)
    expect(isVerifiedAgentTaskBusinessOutcome({...verified,event:{...event,event_type:'coverage.offer.fulfilled'}})).toBe(false)
    expect(isVerifiedAgentTaskBusinessOutcome({...verified,change:{...change,status:'pending'}})).toBe(false)
    expect(isVerifiedAgentTaskBusinessOutcome({...verified,target:{...target,contact_id:'other'}})).toBe(false)
    expect(isVerifiedAgentTaskBusinessOutcome({...verified,supplier:{...supplier,stage:'needs_human'}})).toBe(false)
    expect(isVerifiedAgentTaskBusinessOutcome({...verified,task:{...task,task_type_version:1}})).toBe(false)
    expect(isVerifiedAgentTaskBusinessOutcome({...verified,change:{...change,execution_result:{offer:{id:'different'}}}})).toBe(false)
  })
})
