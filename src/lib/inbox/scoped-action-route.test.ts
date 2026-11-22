import { beforeEach,describe,expect,it,vi } from 'vitest'
const h=vi.hoisted(()=>({role:vi.fn(),gate:vi.fn(),policy:vi.fn(),claim:vi.fn(),fail:vi.fn(),send:vi.fn(),native:vi.fn(),limit:vi.fn()}))
vi.mock('@/lib/auth/account',()=>({requireRole:h.role,UnauthorizedError:class extends Error{},ForbiddenError:class extends Error{}}))
vi.mock('@/lib/automations/admin-client',()=>({supabaseAdmin:()=>({})}))
vi.mock('@/lib/rate-limit',()=>({checkRateLimit:h.limit,rateLimitResponse:()=>new Response(null,{status:429}),RATE_LIMITS:{send:{limit:30,windowMs:60000}}}))
vi.mock('@/lib/whatsapp/send-message',()=>({sendMessageToConversation:h.send}))
vi.mock('./provider-policy',()=>({evaluateInboxPolicy:h.policy}))
vi.mock('./action-intents',()=>({claimInboxAction:h.claim,failInboxAction:h.fail}))
vi.mock('./scoped-native-actions',()=>({runScopedNativeAction:h.native}))
vi.mock('./scoped-ui-gate',()=>({scopedInboxActionsEnabled:h.gate}))
vi.mock('./read-api',()=>({safeInboxMedia:()=>null}))
import {performScopedAction} from './scoped-action-route'
import {ForbiddenError} from '@/lib/auth/account'
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0')
const scope={threadId:id(1),channelId:id(2),connectionId:id(3),membershipId:id(4),provider:'openwa'}
const body={scope,key:id(5),action:'send',payload:{messageType:'text',contentText:'fixture'}}
const request=(b:unknown=body,headers:Record<string,string>={})=>new Request('https://test.example/api/inbox/threads/'+scope.threadId+'/actions',{method:'POST',headers:{'content-type':'application/json','x-wacrm-inbox-account':id(9),'x-wacrm-inbox-actor':id(10),...headers},body:JSON.stringify(b)})
beforeEach(()=>{
 vi.resetAllMocks()
 h.role.mockResolvedValue({accountId:id(9),userId:id(10),supabase:{}})
 h.gate.mockReturnValue(true)
 h.limit.mockReturnValue({success:true})
 h.policy.mockResolvedValue({context:{conversation_id:id(11),membership_id:scope.membershipId,provider:'openwa',recipient:'15550000217@c.us'},capabilities:{may_send_text:true,may_reply:true,may_read:true}})
 h.claim.mockResolvedValue({state:'claimed',intent_id:id(6)})
 h.send.mockResolvedValue({messageId:id(7),whatsappMessageId:'native'})
})
describe('explicit scoped action route',()=>{
 it('passes only the frozen explicit sender to the existing core',async()=>{
  const r=await performScopedAction(request(),scope.threadId)
  expect(r.status).toBe(200)
  expect((await r.json()).message_id).toBe(id(7))
  expect(h.send).toHaveBeenCalledExactlyOnceWith({},id(9),expect.objectContaining({conversationId:id(11),connectionId:scope.connectionId,idempotencyKey:'inbox-action:'+id(6),scopedInbox:{userId:id(10),threadId:scope.threadId,channelId:scope.channelId,membershipId:scope.membershipId,intentId:id(6),provider:'openwa',recipient:'15550000217@c.us'}}))
 })
 it('denies disabled, tenant, role, origin, scope and unsupported operations before admission',async()=>{
  h.gate.mockReturnValueOnce(false)
  expect((await performScopedAction(request(),scope.threadId)).status).toBe(403)
  expect((await performScopedAction(request(body,{'x-wacrm-inbox-account':id(8)}),scope.threadId)).status).toBe(403)
  h.role.mockRejectedValueOnce(new ForbiddenError())
  expect((await performScopedAction(request(),scope.threadId)).status).toBe(403)
  expect((await performScopedAction(request(body,{origin:'https://foreign.example'}),scope.threadId)).status).toBe(403)
  expect((await performScopedAction(request(),id(12))).status).toBe(400)
  expect((await performScopedAction(request({...body,payload:{messageType:'template',templateName:'t',templateLanguage:'en'}}),scope.threadId)).status).toBe(400)
  expect((await performScopedAction(request({...body,action:'reaction',messageId:id(7),emoji:'👍',payload:undefined}),scope.threadId)).status).toBe(400)
  h.policy.mockResolvedValueOnce({context:{membership_id:id(13),provider:'openwa',recipient:'15550000217'},capabilities:{may_send_text:true}})
  expect((await performScopedAction(request(),scope.threadId)).status).toBe(409)
  expect(h.claim).not.toHaveBeenCalled()
  expect(h.send).not.toHaveBeenCalled()
  expect(h.native).not.toHaveBeenCalled()
 })
 it('never calls the provider again on duplicate, conflict, or unknown admission',async()=>{
  for(const state of ['pending','uncertain','blocked','accepted','conflict']){
   h.claim.mockResolvedValueOnce({state,intent_id:id(6),message_id:id(7)})
   const r=await performScopedAction(request(),scope.threadId)
   expect(r.status).toBe(state==='accepted'?200:409)
  }
  h.claim.mockRejectedValueOnce(Error('timeout'))
  const r=await performScopedAction(request(),scope.threadId)
  expect((await r.json()).state).toBe('uncertain')
  expect(h.send).not.toHaveBeenCalled()
 })
 it('distinguishes proven local denial from uncertain dispatch without retry',async()=>{
  h.send.mockRejectedValue(Error('timeout'))
  for(const state of ['blocked','uncertain']){
   h.fail.mockResolvedValueOnce(state)
   expect((await (await performScopedAction(request(),scope.threadId)).json()).state).toBe(state)
  }
  expect(h.send).toHaveBeenCalledTimes(2)
  expect(h.fail).toHaveBeenCalledTimes(2)
 })
})
