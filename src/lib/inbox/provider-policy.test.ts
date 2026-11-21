import { beforeEach,describe,expect,it,vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PolicyContext } from './provider-policy-model'
const mocks=vi.hoisted(()=>({recipient:vi.fn(),client:vi.fn(),consent:vi.fn(),pilot:vi.fn(),hash:vi.fn(),gate:vi.fn()}))
vi.mock('@/lib/whatsapp/transport/openwa/recipient',()=>({resolveOpenWAConversationRecipient:mocks.recipient}))
vi.mock('@/lib/whatsapp/transport/openwa/credentials',()=>({resolveOpenWAClient:mocks.client}))
vi.mock('@/lib/whatsapp/transport/openwa/operational-consent-gate',()=>({assertOpenWAOperationalSendAllowed:mocks.consent}))
vi.mock('@/lib/whatsapp/transport/guardrails',()=>({openWAPilotEnforcementEnabled:mocks.pilot,openWAPilotRecipientHash:mocks.hash}))
vi.mock('@/lib/whatsapp/transport/openwa/environment',()=>({isOpenWATestProject:()=>true}))
vi.mock('./scoped-ui-gate',()=>({scopedInboxEnabled:mocks.gate}))
import { assertInboxSendPolicy,evaluateInboxPolicy } from './provider-policy'
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0')
const selection={accountId:id(1),userId:id(2),threadId:id(3),channelId:id(4),connectionId:id(5)}
const recipient='15551234567'
const context:PolicyContext={thread_id:id(3),conversation_id:id(6),channel_id:id(4),provider:'openwa',connection_id:id(5),membership_id:id(7),ready:true,can_operate:true,recipient,contact_phone:recipient,last_inbound_at:null,server_now:'2026-11-22T01:00:00Z'}
const guard={manual_paused:false,pilot_enabled:true,circuit_open_until:null,hourly_cap:100,daily_cap:1000,first_touch_daily_cap:100,warmup_until:null,warmup_hourly_cap:10,warmup_daily_cap:100,pilot_manual_hourly_cap:null,pilot_manual_daily_cap:null}
function fixture(options:{context?:Partial<PolicyContext>;guard?:Partial<typeof guard>;grant?:boolean;reason?:string;count?:number}={}){
 const rpc=vi.fn(async(name:string)=>({data:name==='inbox_policy_context'?{...context,...options.context}:options.reason??null,error:null}))
 const from=vi.fn((table:string)=>{
  const q={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),gt:vi.fn().mockReturnThis(),gte:vi.fn().mockReturnThis(),in:vi.fn(async()=>({count:options.count??0,error:null})),maybeSingle:vi.fn(async()=>({data:table==='whatsapp_connection_guardrails'?{...guard,...options.guard}:options.grant===false?null:{id:id(8)},error:null}))}
  return q
 })
 return {db:{rpc,from} as unknown as SupabaseClient,rpc,from}
}
const expected={conversationId:id(6),provider:'openwa',connectionId:id(5),membershipId:id(7),recipient,kind:'text'}
beforeEach(()=>{vi.resetAllMocks();mocks.recipient.mockResolvedValue(recipient);mocks.client.mockResolvedValue({});mocks.consent.mockResolvedValue(undefined);mocks.pilot.mockReturnValue(true);mocks.hash.mockReturnValue('hash');mocks.gate.mockReturnValue(true)})
describe('SOF-78 server capability revalidation',()=>{
 it('evaluates the exact selected OpenWA connection without a Meta window or any reservation',async()=>{
  const f=fixture()
  const result=await evaluateInboxPolicy(f.db,selection)
  expect(result?.capabilities).toMatchObject({window_state:'not_applicable',may_send_text:true,may_send_template:false,dispatch_enabled:false})
  expect(result?.capabilities).not.toHaveProperty('recipient')
  expect(f.rpc).toHaveBeenCalledWith('inbox_policy_context',{p_account:id(1),p_actor:id(2),p_thread:id(3),p_channel:id(4),p_connection:id(5)})
  expect(f.rpc.mock.calls.map(c=>c[0])).toEqual(['inbox_policy_context','inbox_openwa_channel_cap_reason'])
  expect(mocks.consent).toHaveBeenCalledWith(f.db,id(1),id(5))
 })
 it('denies paused, unapproved, exhausted, wrong route and read-only cases',async()=>{
  for(const [options,reason] of [[{guard:{manual_paused:true}},'manual_pause'],[{grant:false},'pilot_recipient_not_allowlisted'],[{reason:'channel_hourly_cap'},'channel_hourly_cap'],[{count:100},'hourly_cap'],[{context:{can_operate:false}},'role_read_only']] as const){
   const f=fixture(options)
   expect((await evaluateInboxPolicy(f.db,selection))?.capabilities).toMatchObject({may_send_text:false,blocked_reason:reason})
  }
  mocks.recipient.mockResolvedValueOnce('different')
  expect((await evaluateInboxPolicy(fixture().db,selection))?.capabilities.blocked_reason).toBe('recipient_unverified')
 })
 it('revalidates the same membership and current policy after reservation without charging capacity twice',async()=>{
  const f=fixture({count:100})
  await expect(assertInboxSendPolicy(f.db,selection,expected)).rejects.toMatchObject({providerDispatchAttempted:false})
  f.rpc.mockClear()
  await assertInboxSendPolicy(f.db,selection,expected,true)
  expect(f.rpc.mock.calls.map(c=>c[0])).toEqual(['inbox_policy_context'])
  await expect(assertInboxSendPolicy(fixture({guard:{manual_paused:true}}).db,selection,expected,true)).rejects.toMatchObject({providerDispatchAttempted:false})
  await expect(assertInboxSendPolicy(fixture({context:{membership_id:id(9)}}).db,selection,expected,true)).rejects.toMatchObject({providerDispatchAttempted:false})
 })
 it('never borrows an inbound window from another provider or allows an expired Meta freeform',async()=>{
  const meta={provider:'meta_cloud' as const,last_inbound_at:'2026-11-21T01:00:00Z'}
  const f=fixture({context:meta})
  const e={...expected,provider:'meta_cloud'}
  await expect(assertInboxSendPolicy(f.db,selection,e,true)).rejects.toMatchObject({providerDispatchAttempted:false})
  await assertInboxSendPolicy(f.db,selection,{...e,kind:'template'},true)
  expect(mocks.consent).not.toHaveBeenCalled()
  expect(f.from).not.toHaveBeenCalled()
 })
})
