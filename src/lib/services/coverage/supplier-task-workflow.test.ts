import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  db: null as unknown,
  authorize: vi.fn(),
  runtime: vi.fn(),
  existing: vi.fn(),
  proposed: vi.fn(),
  create: vi.fn(),
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
  createChangeRequest: mocked.create,
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
  route_confirmed:false,route_different:false,
  version:0, last_inbound_message_id:null as string|null,
  confirmation_message_id:null as string|null,confirmation_run_id:null as string|null,
  change_request_id:null as string|null,
  updated_at:'2026-11-16T16:00:00Z',
})
type Negotiation = ReturnType<typeof stageRow>
let row: Negotiation
let priorRunQuotes:Array<{id:string,text:string}>=[]
let currentMessage='نعم يمكنني توفير التغطية'
let previousBotMessage='هل يمكنكم توفير تغطية بقيمة 400 SAR؟'
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
      let regionIds: string[] | null = null
      let messageIds: string[] | null = null
      const conditions:Record<string,unknown>={}
      const query={
        select(_fields?:string) { return query },
        eq(field:string,val:unknown) { conditions[field]=val; return query },
        lt(_field:string,_val:unknown) { return query },
        order(_field:string,_opts?:unknown) { return query },
        in(field:string, vals:unknown[]) {
          if(table==='coverage_regions' && field==='id') regionIds=vals as string[]
          if(table==='messages' && field==='id') messageIds=vals as string[]
          return query
        },
        limit(n:number) {
          if(table==='messages') {
            return Promise.resolve({data:[{ content_text:previousBotMessage }].slice(0,n),error:null})
          }
          if(table==='ai_agent_runs') {
            return Promise.resolve({data:priorRunQuotes.slice(0,n).map(r=>({
              inbound_message_id:r.id,created_at:'2026-11-16T15:00:00Z',
            })),error:null})
          }
          if(table==='coverage_regions') {
            return Promise.resolve({data:[
              {id:northId,name:'إب'}, {id:southId,name:'حضرموت'},
              {id:'11111111-2222-4333-8444-555555555555',name:'صنعاء'},
            ].filter(r=>!regionIds || regionIds.includes(r.id)).slice(0,n),error:null})
          }
          throw new Error('unexpected .limit '+table)
        },
        upsert(payload:Record<string,unknown>) {
          storeWrites.push({table,op:'upsert',changes:payload})
          return Promise.resolve({error:null})
        },
        update(patch:Record<string,unknown>) { operation='update';values=patch;return query },
        then<T>(resolve:(result:{error:null;data?:unknown})=>T):Promise<T> {
          if(operation==='read' && table==='messages' && messageIds) {
            return Promise.resolve({error:null as null,data:priorRunQuotes
              .filter(r=>messageIds?.includes(r.id)).map(r=>({id:r.id,content_text:r.text}))}).then(resolve)
          }
          if(operation==='update' && table==='ai_agent_coverage_supplier_negotiations') {
            storeWrites.push({table,op:'update',changes:values})
            Object.assign(row,values)
          }
          return Promise.resolve({error:null as null}).then(resolve)
        },
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
  priorRunQuotes=[]
  previousBotMessage='هل يمكنكم توفير تغطية بقيمة 400 SAR؟'
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
  mocked.create.mockResolvedValue({id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    code:1170,status:'pending',confirmationCode:'1234'})
})

describe('server-bound Coverage supplier lifecycle',()=>{
  async function reply(message:string, index:number) {
    currentMessage=message
    currentRun=`aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12,'0')}`
    currentSource=`bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12,'0')}`
    return await handleCoverageSupplierTaskReply(sourceContext())
  }

  it('uses the first affirmative response to accept the route; only asks for missing price/rate',async()=>{
    const r=await reply('نعم يمكنني توفير التغطية',1)
    expect(r?.text).toContain('400 SAR')
    expect(row.stage).toBe('amount')
    expect(row.route_confirmed).toBe(true)
    expect(row.route_different).toBe(false)
    expect(mocked.proposed).not.toHaveBeenCalled()
  })
  it('creates a native admin approval from the full user quote in ONE inbound turn',async()=>{
    const msg='نعم واستطيع توفير المبلغ كامل 400 واريد عموله 7 لكل 1000 وطريقة الدفع والاستلام اي طريقة متوفر عادي اكد على العرض'
    const res=await reply(msg,1)
    expect(row.stage).toBe('submitted')
    expect(row.route_confirmed).toBe(true)
    expect(row.route_different).toBe(false)
    expect(row.change_request_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    expect(res?.text).toContain('CHG-1170')
    expect(mocked.proposed).toHaveBeenCalledTimes(1)
    const [ctx,proposal]=mocked.proposed.mock.calls[0]
    expect(ctx).toMatchObject({accountId,contactId,conversationId,sourceMessageId:currentSource})
    expect(proposal).toMatchObject({
      total_amount:'400',currency:'SAR',
      commission_per_thousand:'7',
      attributes:{pay_region_id:southId,receive_region_id:northId},
      supplier_task:{task_id:taskId,task_target_id:targetId,
        source_request_id:requestId,supplier_details:msg},
    })
    expect(mocked.create).not.toHaveBeenCalled()
  })
  it('asks both missing money terms in one reply and submits once they arrive',async()=>{
    const r1=await reply('نعم',1)
    expect(r1?.text).toContain('المبلغ')
    expect(r1?.text).toContain('العمولة')
    await reply('400',2)
    expect(row.offered_amount).toBe('400')
    const done=await reply('7',3)
    expect(done?.text).toContain('CHG-1170')
    expect(mocked.proposed).toHaveBeenCalledTimes(1)
  })
  it('accepts natural route assent without repeating the entire request',async()=>{
    Object.assign(row,{stage:'route',version:1})
    const result=await reply('نعم المسار مطابق',9)
    expect(result?.text).not.toContain('لم نتلق')
    expect(row.route_confirmed).toBe(true)
    expect(row.stage).toBe('amount')
  })
  it('continues a pre-migration commission-confirmation question without inferring amount or details',async()=>{
    previousBotMessage='شكراً! للتأكيد، العمولة **7 لكل 1000**؟'
    const result=await reply('نعم أؤكد',9)
    expect(row).toMatchObject({stage:'amount',commission_per_thousand:'7',offered_amount:null})
    expect(result?.text).toContain('المبلغ')
    expect(mocked.proposed).not.toHaveBeenCalled()
  })
  it('fails closed when the frozen proposal permission is revoked',async()=>{
    Object.assign(row,{stage:'confirmation',offered_amount:'400',commission_per_thousand:'7',
      supplier_details:'حوالة من حضرموت إلى إب اليوم',route_confirmed:true,version:4})
    mocked.authorize.mockResolvedValue({ok:false,code:'NO_GRANT'})
    const r=await reply('تأكيد',7)
    expect(r?.text).toContain('متابعة بشرية')
    expect(row.stage).toBe('needs_human')
    expect(mocked.proposed).not.toHaveBeenCalled()
  })
  it('raises mismatched supplier terms for ADMIN REVIEW only, no false matching Coverage Offer',async()=>{
    const msg='نعم اوفر 300 ريال عموله 7 لكل 1000 لكن أستلم في صنعاء بدل إب، اكد على العرض'
    const res=await reply(msg,1)
    expect(row.route_different).toBe(true)
    expect(row.route_confirmed).toBe(false)
    expect(row.stage).toBe('submitted')
    expect(res?.text).toContain('البديل')
    expect(mocked.proposed).not.toHaveBeenCalled()
    expect(mocked.create).toHaveBeenCalledTimes(1)
    const proposal=mocked.create.mock.calls[0][0]
    expect(proposal).toMatchObject({actionKey:'coverage.supplier_counteroffer.review',
      targetType:'coverage_supplier_quote',sourceRunId:currentRun,
      proposedPayload:{source_task_id:taskId,source_task_target_id:targetId,
        supplier_terms:{route_match:false,supplier_route_statement:msg}},
    })
    expect(proposal.summary).toContain('مراجعة بشرية')
  })

  it('recovers the original full quote from signed previous Task replies, without asking 550/7 again',async()=>{
    const text='نعم واستطيع توفير المبلغ كامل 400 واريد عموله 7 لكل 1000 وطريقة الدفع والاستلام اي طريقة متوفر عادي اكد على العرض'
    priorRunQuotes=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-111111111111',text}]
    Object.assign(row,{stage:'amount',version:4,route_confirmed:true,
      last_inbound_message_id:'aaaaaaaa-aaaa-4aaa-8aaa-222222222222'})
    const res=await reply('تأكيد',9)
    expect(res?.text).toContain('CHG-1170')
    expect(row.stage).toBe('submitted')
    expect(row.supplier_details).toContain('المبلغ كامل 400')
    expect(mocked.proposed).toHaveBeenCalledTimes(1)
    expect(mocked.proposed.mock.calls[0][1].supplier_task.supplier_details).toBe(text)
  })
  it('does not revive a previous supplier quote after a later edit',async()=>{
    const text='نعم واستطيع توفير المبلغ كامل 400 واريد عموله 7 لكل 1000 اكد على العرض'
    priorRunQuotes=[
      {id:'aaaaaaaa-aaaa-4aaa-8aaa-222222222222',text:'تعديل'},
      {id:'aaaaaaaa-aaaa-4aaa-8aaa-111111111111',text},
    ]
    Object.assign(row,{stage:'amount',version:4,route_confirmed:true,
      last_inbound_message_id:'aaaaaaaa-aaaa-4aaa-8aaa-333333333333'})
    const res=await reply('تأكيد',9)
    expect(res?.text).toContain('المبلغ')
    expect(mocked.proposed).not.toHaveBeenCalled()
  })

  it('recovers a previously committed proposal after a crash without proposing twice',async()=>{
    const details='الدفع في حضرموت والاستلام في إب حوالة خلال اليوم'
    const confirmed='bbbbbbbb-bbbb-4bbb-8bbb-000000000007'
    Object.assign(row,{stage:'submitting',offered_amount:'400',
      commission_per_thousand:'7',supplier_details:details,route_confirmed:true,version:5,
      confirmation_message_id:confirmed})
    mocked.existing.mockResolvedValue({
      id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',code:1170,status:'pending',
      action_key:'coverage.offer.create',
      proposed_payload:{
        contact_id:contactId,conversation_id:conversationId,service_id:'service-uuid',
        total_amount:'400',currency:'SAR',commission_per_thousand:'7',
        source_task_id:taskId,source_task_target_id:targetId,source_coverage_request_id:requestId,
        supplier_terms:{details,explicitly_confirmed_in_message_id:confirmed},
      },
    })
    const r=await reply('هل تم رفع العرض؟',10)
    expect(r?.text).toContain('CHG-1170')
    expect(row).toMatchObject({stage:'submitted',change_request_id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'})
    expect(mocked.proposed).not.toHaveBeenCalled()
  })
  it('fails closed on a stale uncommitted submission instead of silently retrying',async()=>{
    Object.assign(row,{stage:'submitting',offered_amount:'400',
      commission_per_thousand:'7',supplier_details:'حوالة من حضرموت إلى إب اليوم',
      confirmation_message_id:'bbbbbbbb-bbbb-4bbb-8bbb-000000000007',
      updated_at:'2020-01-01T00:00:00Z'})
    const r=await reply('هل وصل الطلب؟',11)
    expect(row.stage).toBe('needs_human')
    expect(r?.text).toContain('متابعة بشرية')
    expect(mocked.proposed).not.toHaveBeenCalled()
  })
  it('rejects mismatched previously committed supplier terms without re-proposing',async()=>{
    Object.assign(row,{stage:'submitting',offered_amount:'400',
      commission_per_thousand:'7',supplier_details:'حوالة من حضرموت إلى إب اليوم',
      confirmation_message_id:'bbbbbbbb-bbbb-4bbb-8bbb-000000000007',
      updated_at:'2020-01-01T00:00:00Z'})
    mocked.existing.mockResolvedValue({
      id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',code:1170,status:'pending',
      action_key:'coverage.offer.create',proposed_payload:{
        contact_id:contactId,conversation_id:conversationId,
        source_task_id:taskId,source_task_target_id:targetId,source_coverage_request_id:requestId,
        service_id:'service-uuid',total_amount:'300',currency:'SAR',commission_per_thousand:'7',
        supplier_terms:{details:'مختلف',explicitly_confirmed_in_message_id:row.confirmation_message_id},
      },
    })
    const r=await reply('تأكيد',12)
    expect(row.stage).toBe('needs_human')
    expect(r?.text).toContain('متابعة بشرية')
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
