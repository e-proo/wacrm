import { beforeEach,describe,expect,it,vi } from 'vitest'
const h=vi.hoisted(()=>({role:vi.fn(),gate:vi.fn(),policy:vi.fn(),claim:vi.fn(),fail:vi.fn(),send:vi.fn(),native:vi.fn(),limit:vi.fn(),readGate:vi.fn(),from:vi.fn(),rpc:vi.fn()}))
vi.mock('@/lib/auth/account',()=>({requireRole:h.role,UnauthorizedError:class extends Error{},ForbiddenError:class extends Error{}}))
vi.mock('@/lib/automations/admin-client',()=>({supabaseAdmin:()=>({from:h.from,rpc:h.rpc})}))
vi.mock('@/lib/rate-limit',()=>({checkRateLimit:h.limit,rateLimitResponse:()=>new Response(null,{status:429}),RATE_LIMITS:{send:{limit:30,windowMs:60000}}}))
vi.mock('@/lib/whatsapp/send-message',()=>({sendMessageToConversation:h.send}))
vi.mock('./provider-policy',()=>({evaluateInboxPolicy:h.policy}))
vi.mock('./action-intents',()=>({claimInboxAction:h.claim,failInboxAction:h.fail}))
vi.mock('./scoped-native-actions',()=>({runScopedNativeAction:h.native}))
vi.mock('./scoped-ui-gate',()=>({scopedInboxActionsEnabled:h.gate,scopedInboxEnabled:h.readGate}))
vi.mock('./read-api',()=>({safeInboxMedia:()=>null}))
import {performScopedAction,openScopedThread,getScopedAction} from './scoped-action-route'
import {ForbiddenError} from '@/lib/auth/account'
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0')
const scope={threadId:id(1),channelId:id(2),connectionId:id(3),membershipId:id(4),provider:'openwa'}
const body={scope,key:id(5),action:'send',payload:{messageType:'text',contentText:'fixture'}}
const request=(b:unknown=body,headers:Record<string,string>={})=>new Request('https://test.example/api/inbox/threads/'+scope.threadId+'/actions',{method:'POST',headers:{'content-type':'application/json','x-wacrm-inbox-account':id(9),'x-wacrm-inbox-actor':id(10),...headers},body:JSON.stringify(b)})
beforeEach(()=>{
 vi.resetAllMocks()
 h.role.mockResolvedValue({accountId:id(9),userId:id(10),supabase:{}})
 h.gate.mockReturnValue(true)
 h.readGate.mockReturnValue(true)
 const query={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),is:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:{id:scope.membershipId},error:null})}
 h.from.mockReturnValue(query)
 h.rpc.mockResolvedValue({data:id(14),error:null})
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

describe('explicit new-thread and status-only recovery',()=>{
 const b={contactId:id(13),channelId:scope.channelId,connectionId:scope.connectionId,provider:'openwa'}
 const open=(payload:unknown=b,headers:Record<string,string>={})=>new Request('https://test.example/api/inbox/threads',{
  method:'POST',headers:{'content-type':'application/json','x-wacrm-inbox-account':id(9),'x-wacrm-inbox-actor':id(10),...headers},body:JSON.stringify(payload),
 })
 it('requires a chosen channel, connection and existing contact; server binds the active membership',async()=>{
  const r=await openScopedThread(open())
  expect(r.status).toBe(200)
  expect((await r.json()).thread_id).toBe(id(14))
  expect(h.from).toHaveBeenCalledWith('whatsapp_channel_memberships')
  expect(h.rpc).toHaveBeenCalledExactlyOnceWith('inbox_open_explicit_thread',{p_account:id(9),p_actor:id(10),p_contact:id(13),p_channel:scope.channelId,p_connection:scope.connectionId,p_membership:scope.membershipId,p_provider:'openwa'})
  expect(h.send).not.toHaveBeenCalled()
  expect(h.native).not.toHaveBeenCalled()
 })
 it('rejects unauthenticated context, missing connection and forged epoch without side effects',async()=>{
  expect((await openScopedThread(open(b,{'x-wacrm-inbox-account':id(8)}))).status).toBe(403)
  expect((await openScopedThread(open({...b,connectionId:null}))).status).toBe(400)
  expect((await openScopedThread(open({...b,membershipId:id(20)}))).status).toBe(400)
  expect(h.from).not.toHaveBeenCalled()
  expect(h.rpc).not.toHaveBeenCalled()
 })
 it('keeps result inspection available when the independent writer switch is disabled',async()=>{
  h.gate.mockReturnValue(false)
  h.from.mockReturnValue({select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:{id:id(6),state:'uncertain',message_id:id(7)},error:null})})
  const req=new Request('https://test.example/api/inbox/threads/'+scope.threadId+'/actions?key='+id(5),{headers:{'x-wacrm-inbox-account':id(9),'x-wacrm-inbox-actor':id(10)}})
  const response=await getScopedAction(req,scope.threadId)
  expect(response.status).toBe(200)
  expect((await response.json()).state).toBe('uncertain')
  expect(h.send).not.toHaveBeenCalled()
 })
})
