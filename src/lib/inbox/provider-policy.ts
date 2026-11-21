import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { assertOpenWAOperationalSendAllowed } from '@/lib/whatsapp/transport/openwa/operational-consent-gate'
import { openWAPilotEnforcementEnabled,openWAPilotRecipientHash } from '@/lib/whatsapp/transport/guardrails'
import { resolveOpenWAClient } from '@/lib/whatsapp/transport/openwa/credentials'
import { OpenWAPreDispatchDenied } from '@/lib/whatsapp/transport/openwa/pre-dispatch-denied'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/openwa/environment'
import { resolveOpenWAConversationRecipient } from '@/lib/whatsapp/transport/openwa/recipient'
import { deriveInboxCapabilities,allowsContent,type InboxCapabilities,type PolicyContext,type PolicyReason } from './provider-policy-model'
import { scopedInboxEnabled } from './scoped-ui-gate'
import { validId } from './scoped-list-model'

export type PolicySelection={accountId:string;userId:string;threadId:string;channelId:string;connectionId:string|null}
type Guard={manual_paused:boolean;pilot_enabled:boolean;circuit_open_until:string|null;hourly_cap:number;daily_cap:number;first_touch_daily_cap:number;warmup_until:string|null;warmup_hourly_cap:number;warmup_daily_cap:number;pilot_manual_hourly_cap:number|null;pilot_manual_daily_cap:number|null}
const caps=['channel_hourly_cap','channel_daily_cap','channel_first_touch_cap','channel_policy_unavailable'] as const
export class ScopedInboxPolicyDenied extends WhatsAppTransportError {
 readonly providerDispatchAttempted=false as const
 constructor(){super('connection_restricted','Inbox policy does not authorize the selected sender or message; refresh the conversation')}
}
const contextError=()=>new ScopedInboxPolicyDenied()
export async function loadPolicyContext(db:SupabaseClient,s:PolicySelection):Promise<PolicyContext|null>{
 if(![s.accountId,s.userId,s.threadId,s.channelId].every(validId)||(s.connectionId!==null&&!validId(s.connectionId)))throw contextError()
 const {data,error}=await db.rpc('inbox_policy_context',{p_account:s.accountId,p_actor:s.userId,p_thread:s.threadId,p_channel:s.channelId,p_connection:s.connectionId})
 if(error)throw contextError()
 if(data===null)return null
 const c=data as PolicyContext
 if(!c||c.thread_id!==s.threadId||c.channel_id!==s.channelId||!validId(c.conversation_id)||!['meta_cloud','openwa'].includes(c.provider)||typeof c.ready!=='boolean'||typeof c.can_operate!=='boolean'||(s.connectionId!==null&&s.connectionId!==c.connection_id)||((c.connection_id===null)!==(c.membership_id===null))||(c.connection_id!==null&&(!validId(c.connection_id)||!validId(c.membership_id)))||!Number.isFinite(Date.parse(c.server_now)))throw contextError()
 return c
}
// Read-only preview. No Pilot audit event, cap reservation, network dispatch,
// credential serialization or mutation. The existing transport checks again.
async function inspectOpenWAPolicy(db:SupabaseClient,s:PolicySelection,c:PolicyContext,afterReservation=false):Promise<PolicyReason|null>{
 const conn=c.connection_id,recipient=c.recipient
 if(!conn||!recipient)return 'recipient_unverified'
 try{
  const actual=await resolveOpenWAConversationRecipient(db,{accountId:s.accountId,conversationId:c.conversation_id,connectionId:conn,fallbackPhone:c.contact_phone??''})
  if(actual!==recipient)return 'recipient_unverified'
  await resolveOpenWAClient(db,s.accountId,conn)
  await assertOpenWAOperationalSendAllowed(db,s.accountId,conn)
 }catch(e){return e instanceof OpenWAPreDispatchDenied?'operational_denied':e instanceof WhatsAppTransportError&&e.code==='connection_restricted'?'recipient_unverified':'policy_unavailable'}
 const {data,error}=await db.from('whatsapp_connection_guardrails').select('manual_paused,pilot_enabled,circuit_open_until,hourly_cap,daily_cap,first_touch_daily_cap,warmup_until,warmup_hourly_cap,warmup_daily_cap,pilot_manual_hourly_cap,pilot_manual_daily_cap').eq('account_id',s.accountId).eq('connection_id',conn).maybeSingle()
 if(error||!data)return 'policy_unavailable'
 const g=data as Guard,now=Date.parse(c.server_now)
 if(g.manual_paused!==false)return 'manual_pause'
 if(g.circuit_open_until!==null&&(!Number.isFinite(Date.parse(g.circuit_open_until))||Date.parse(g.circuit_open_until)>now))return 'failure_circuit_open'
 const pilot=openWAPilotEnforcementEnabled()&&(!isOpenWATestProject()||g.pilot_enabled!==false)
 if(pilot){
  const hash=openWAPilotRecipientHash(s.accountId,conn,recipient)
  if(!hash)return 'recipient_unverified'
  const {data:grant,error:grantError}=await db.from('whatsapp_openwa_pilot_allowlist').select('id').eq('account_id',s.accountId).eq('connection_id',conn).eq('recipient_hash',hash).eq('workload','manual').eq('active',true).gt('expires_at',c.server_now).maybeSingle()
  if(grantError)return 'policy_unavailable'
  if(!grant)return 'pilot_recipient_not_allowlisted'
 }
 if(afterReservation)return null // Existing atomic reservations already counted this send.
 const rawHash=createHash('sha256').update(s.accountId+':'+conn+':'+recipient).digest('hex')
 const {data:reason,error:capError}=await db.rpc('inbox_openwa_channel_cap_reason',{p_account:s.accountId,p_channel:s.channelId,p_connection:conn,p_hash:rawHash})
 if(capError||reason!==null&&!caps.includes(reason))return 'policy_unavailable'
 if(reason)return reason as PolicyReason
 const warm=g.warmup_until!==null&&Date.parse(g.warmup_until)>now
 const h=warm?Math.min(g.hourly_cap,g.warmup_hourly_cap):g.hourly_cap,d=warm?Math.min(g.daily_cap,g.warmup_daily_cap):g.daily_cap
 if(![h,d,g.first_touch_daily_cap].every(x=>Number.isInteger(x)&&x>=0)||h===0||d===0)return 'policy_unavailable'
 const count=async(ms:number,manual:boolean)=>await db.from('whatsapp_guardrail_events').select('id',{count:'exact',head:true}).eq('account_id',s.accountId).eq('connection_id',conn).eq('decision','reserved').gte('created_at',new Date(now-ms).toISOString()).in('workload',manual?['manual']:['manual','agent','automation','broadcast','api'])
 const [hour,day]=await Promise.all([count(3600000,false),count(86400000,false)])
 if(hour.error||day.error||hour.count===null||day.count===null)return 'policy_unavailable'
 if(hour.count>=h)return 'hourly_cap'
 if(day.count>=d)return 'daily_cap'
 if(pilot&&isOpenWATestProject()){
  const [mh,md]=await Promise.all([count(3600000,true),count(86400000,true)])
  if(mh.error||md.error||mh.count===null||md.count===null)return 'policy_unavailable'
  if(mh.count>=Math.min(g.hourly_cap,g.pilot_manual_hourly_cap??g.hourly_cap))return 'pilot_workload_hourly_cap'
  if(md.count>=Math.min(g.daily_cap,g.pilot_manual_daily_cap??g.daily_cap))return 'pilot_workload_daily_cap'
 }
 return null
}
export async function evaluateInboxPolicy(db:SupabaseClient,s:PolicySelection,options:{afterReservation?:boolean}={}):Promise<{context:PolicyContext;capabilities:InboxCapabilities}|null>{
 const c=await loadPolicyContext(db,s)
 if(!c)return null
 const initial=deriveInboxCapabilities(c)
 let denial:PolicyReason|null=null
 if(c.provider==='openwa'&&initial.blocked_reason===null){
  try{denial=await inspectOpenWAPolicy(db,s,c,options.afterReservation)}catch{denial='policy_unavailable'}
 }
 return {context:c,capabilities:deriveInboxCapabilities(c,denial)}
}
// Server-side fence for SOF-85's explicit sender. The existing guarded
// transport remains the admission and reservation authority.
export async function assertInboxSendPolicy(db:SupabaseClient,s:PolicySelection,expected:{conversationId:string;provider:string;connectionId:string;membershipId:string;recipient:string;kind:string},afterReservation=false):Promise<void>{
 if(!scopedInboxEnabled()||s.connectionId!==expected.connectionId)throw contextError()
 let result:Awaited<ReturnType<typeof evaluateInboxPolicy>>
 try{result=await evaluateInboxPolicy(db,s,{afterReservation})}catch{throw contextError()}
 if(!result||result.context.conversation_id!==expected.conversationId||result.context.provider!==expected.provider||result.context.connection_id!==expected.connectionId||result.context.membership_id!==expected.membershipId||result.context.recipient!==expected.recipient||!allowsContent(result.capabilities,expected.kind))throw contextError()
}
