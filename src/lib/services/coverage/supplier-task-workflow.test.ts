import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  db: null as unknown,
  authorize: vi.fn(),
  runtime: vi.fn(),
  existing: vi.fn(),
  proposed: vi.fn(),
  policy: vi.fn(),
  manifest: vi.fn(),
}))
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => mocked.db }))
vi.mock('@/lib/ai/tasks/capability-policy', () => ({
  authorizeStoredAgentTask: mocked.authorize,
}))
vi.mock('@/lib/ai/runtime/runtime-policy', () => ({
  loadAccountRuntimePolicy: mocked.runtime,
}))
vi.mock('@/lib/ai/runtime/change-requests-service', () => ({
  findChangeRequestByIdempotencyKey: mocked.existing,
}))
vi.mock('@/lib/ai/tools/business-handoff', () => ({
  executeCoverageProposeOfferIntegrated: mocked.proposed,
}))
vi.mock('@/lib/ai/runtime/tool-policy', () => ({
  authorizeToolInvocation: mocked.policy,
}))
vi.mock('@/lib/ai/tools/platform/current-domain-registry', () => ({
  getCurrentPlatformTool: mocked.manifest,
}))
vi.mock('@/lib/ai/tasks/current-platform', () => ({
  CURRENT_AGENT_TASK_PLATFORM: { taskTypes: {} },
}))
import { handleCoverageSupplierTaskReply, type SupplierReplyInput } from './supplier-task-workflow'

const taskId = '11111111-1111-4111-8111-111111111111'
const targetId = '22222222-2222-4222-8222-222222222222'
const accountId = '33333333-3333-4333-8333-333333333333'
const conversationId = '44444444-4444-4444-8444-444444444444'
const contactId = '55555555-5555-4555-8555-555555555555'
const requestId = '66666666-6666-4666-8666-666666666666'
const revisionId = '77777777-7777-4777-8777-777777777777'
const northId = '88888888-8888-4888-8888-888888888888'
const southId = '99999999-9999-4999-8999-999999999999'
const stageRow = () => ({
  account_id:accountId, task_id:taskId, task_target_id:targetId, contact_id:contactId,
  conversation_id:conversationId, stage:'availability', offered_amount:null as string|null,
  commission_per_thousand:null as string|null,supplier_details:null as string|null,
  version:0, last_inbound_message_id:null as string|null,
  confirmation_message_id:null as string|null,confirmation_run_id:null as string|null,
  change_request_id:null as string|null,
})
type Negotiation = ReturnType<typeof stageRow>
let row: Negotiation
let currentMessage='نعم يمكنني توفير التغطية'
let currentRun='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
let currentSource='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
let storeWrites: Array<{table:string,op:string,changes:Record<string,unknown>}> = []
const sourceContext=():SupplierReplyInput=>({
  accountId,taskId,taskTargetId:targetId,runId:currentRun,
  contactId,conversationId,sourceMessageId:currentSource,
})
function makeDb() {
  return {
    from(table:string) {
      let operation:'read'|'update'='read'
      let values:Record<string,unknown>={}
      let conditions:Record<string,unknown>={}
      const query={
        select(_fields?:string) { return query },
        eq(field:string,val:unknown) { conditions[field]=val; return query },
        lt(_field:string,_val:unknown) { return query },
        order(_field:string,_opts?:unknown) { return query },
        limit(n:number) {
          if(table==='messages') {
            return Promise.resolve({data:[{ content_text:'شكراً! للتأكيد، العمولة **7 لكل 1000**؟' }].slice(0,n),error:null})
          }
          throw new Error('unexpected .limit')
        },
        upsert(payload:Record<string,unknown>) {
          storeWrites.push({table,op:'upsert',changes:payload})
          return Promise.resolve({error:null})
        },
        update(patch:Record<string,unknown>) { operation='update';values=patch;return query },
        async maybeSingle() {
          if(operation==='update') {
            storeWrites.push({table,op:'update',changes:values})
            if(table!=='ai_agent_coverage_supplier_negotiations') throw new Error('unexpected update')
            if(conditions.version!==undefined && conditions.version!==row.version)
              return {data:null,error:null}
            if(conditions.stage!==undefined && conditions.stage!==row.stage)
              return {data:null,error:null}
            Object.assign(row, values)
            return {data: {...row},error:null}
          }
          const data:Record<string,unknown>={
            ai_agent_tasks: { id:taskId,task_type:'coverage.sourcing',task_type_version:2,status:'running',
              task_context:{coverageRequestId:requestId} },
            ai_agent_task_targets: { id:targetId,contact_id:contactId,conversation_id:conversationId,
              status:'replied' },
            ai_agent_runs: {id:currentRun,status:'claimed',run_mode:'inbound',
              task_id:taskId,task_target_id:targetId,conversation_id:conversationId,
              inbound_message_id:currentSource},
            messages:{id:currentSource,created_at:'2026-11-16T16:00:00Z',sender_type:'customer',
              content_text:currentMessage},
            coverage_requests:{id:requestId,service_id:'service-uuid',currency:'SAR',status:'active',
              requested_amount:'400',reserved_amount:'0',fulfilled_amount:'0',
              attributes:{coverage_scope:'domestic',pay_region_id:northId,receive_region_id:southId,
                pay_method:'any',receive_method:'any'}},
            ai_agent_coverage_supplier_negotiations:{...row},
            ai_agent_tool_grants:{tool_version:2,permission:'propose',constraints:{}},
            change_requests:null,
          }
          if(!(table in data)) throw new Error('unknown table '+table)
          return {data:data[table],error:null}
        },
      }
      return query
    },
  }
}
beforeEach(()=>{
  vi.clearAllMocks()
  storeWrites=[]
  row=stageRow()
  currentMessage='نعم يمكنني توفير التغطية'
  currentRun='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  currentSource='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  mocked.db=makeDb()
  mocked.authorize.mockResolvedValue({ok:true,task:{agentRevisionId:revisionId},
    capabilities:['coverage.propose','coverage.sourcing'],
    allowedTools:[{key:'coverage.propose_offer',version:2}]})
  mocked.runtime.mockResolvedValue({
    killSwitch:false,nativeToolsEnabled:true,proposalToolsEnabled:true,
  })
  mocked.existing.mockResolvedValue(null)
  mocked.policy.mockReturnValue({ok:true})
  mocked.manifest.mockReturnValue({key:'coverage.propose_offer',version:2})
  mocked.proposed.mockResolvedValue({
    ok:true,data:{change_request:{id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',code:1170,status:'pending'}},
    safe_to_show:true,
  })
})

describe('server-bound Coverage supplier lifecycle',()=>{
  async function reply(message:string, index:number) {
    currentMessage=message
    currentRun=`aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12,'0')}`
    currentSource=`bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12,'0')}`
    return await handleCoverageSupplierTaskReply(sourceContext())
  }

  it('starts collecting source-request amount and never proposes on availability alone',async()=>{
    const r=await reply('نعم يمكنني توفير التغطية',1)
    expect(r?.text).toContain('400 SAR')
    expect(row.stage).toBe('amount')
    expect(mocked.proposed).not.toHaveBeenCalled()
  })
  it('only creates a native administrative proposal after gathering terms and explicit supplier confirmation',async()=>{
    const r1=await reply('نعم يمكنني توفير التغطية',1)
    expect(r1?.text).toContain('المبلغ')
    expect(row.stage).toBe('amount')
    await reply('400',2)
    expect(row.stage).toBe('commission')
    await reply('7',3)
    expect(row.stage).toBe('details')
    await reply('الدفع في حضرموت والاستلام في إب حوالة خلال اليوم بدون شروط إضافية',4)
    expect(row.stage).toBe('confirmation')
    await reply('تمام',5)
    expect(row.stage).toBe('confirmation')
    expect(mocked.proposed).not.toHaveBeenCalled()
    const res=await reply('تأكيد',6)
    expect(row.stage).toBe('submitted')
    expect(row.change_request_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    expect(res?.text).toContain('CHG-1170')
    expect(res?.text).toContain('ليس معتمدًا')
    expect(mocked.proposed).toHaveBeenCalledTimes(1)
    const [ctx,proposal]=mocked.proposed.mock.calls[0]
    expect(ctx).toMatchObject({accountId,contactId,conversationId,sourceMessageId:currentSource})
    expect(proposal).toMatchObject({
      total_amount:'400',currency:'SAR',
      commission_per_thousand:'7',
      attributes:{pay_region_id:southId,receive_region_id:northId},
      supplier_task:{task_id:taskId,task_target_id:targetId,source_request_id:requestId},
    })
    expect(mocked.policy).toHaveBeenCalledWith(expect.objectContaining({
      constraints:{},context:expect.objectContaining({plane:'customer',proposalToolsEnabled:undefined}),
    }))
  })
  it('fails closed when the frozen proposal permission is revoked',async()=>{
    Object.assign(row,{stage:'confirmation',offered_amount:'400',commission_per_thousand:'7',
      supplier_details:'حوالة من حضرموت إلى إب اليوم',version:4})
    mocked.authorize.mockResolvedValue({ok:false,code:'NO_GRANT'})
    const r=await reply('تأكيد',7)
    expect(r?.text).toContain('متابعة بشرية')
    expect(row.stage).toBe('needs_human')
    expect(mocked.proposed).not.toHaveBeenCalled()
  })
  it('never re-proposes a submitted supplier quote on repeated confirmation',async()=>{
    Object.assign(row,{stage:'submitted',
      change_request_id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'})
    const r=await reply('تأكيد',8)
    expect(r?.text).toContain('قيد مراجعة')
    expect(mocked.proposed).not.toHaveBeenCalled()
  })
})
