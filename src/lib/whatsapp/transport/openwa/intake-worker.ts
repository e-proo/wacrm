import type { SupabaseClient } from '@supabase/supabase-js'
import { canonicalInboxTestMode } from '@/lib/inbox/canonical-ingress'
import { durableOpenWAIntakeEnabled,readIntakeClaim,openIntake } from './durable-intake'
import { createOpenWAWebhookDb,processReservedOpenWAWebhook } from './webhook-processing'
export const INTAKE_HEARTBEAT_MS=20_000
/** Keep one renewal in flight. A denied/expired renewal never retries the
 * handler or resurrects its lease. The durable ledger decides the outcome. */
function startHeartbeat(db:SupabaseClient,claim:{id:string;token:string},canonical:boolean,lifecycle:boolean){
 let active=true,inFlight=false
 const timer=setInterval(()=>{
  if(!active||inFlight)return
  inFlight=true
  void (async()=>{
   try{
    const {data,error}=await db.rpc('openwa_renew_signed_intake',{p_id:claim.id,p_token:claim.token,p_canonical:canonical,p_lifecycle:lifecycle}).abortSignal(AbortSignal.timeout(10_000))
    if(!error&&data!==true){active=false;clearInterval(timer)}
   }catch{/* A transient failure cannot extend or reclaim a lease. */}
   finally{inFlight=false}
  })()
 },INTAKE_HEARTBEAT_MS)
 return ()=>{active=false;clearInterval(timer)}
}
/** At most one claim per tick. No retry after entering the business pipeline.
 * An expired/uncertain claim remains evidence for operator reconciliation. */
export async function processOpenWAIntakeTick(db:SupabaseClient=createOpenWAWebhookDb()){
 if(!durableOpenWAIntakeEnabled())return {claimed:0,completed:0,review:0,disabled:true}
 const canonical=canonicalInboxTestMode()
 const {data,error}=await db.rpc('openwa_claim_signed_intake_v2',{p_canonical:canonical})
 if(error)throw Error('Intake claim unavailable')
 if(data?.state==='idle')return {claimed:0,completed:0,review:0,disabled:false}
 if(data?.state==='review')return {claimed:0,completed:0,review:1,disabled:false}
 const claim=readIntakeClaim(data)
 if(!claim)throw Error('Intake claim unavailable')
 let reason:'payload_unavailable'|'processing_uncertain'|null='payload_unavailable'
 try{
  if(claim.canonical!==canonical)throw Error('Intake mode changed')
  const envelope=openIntake(claim)
  reason='processing_uncertain'
  const event=envelope.event.toLowerCase().replace(/[\s_-]+/g,'.')
  const lifecycle=['session.status','session.authenticated','session.disconnected','session.restriction'].includes(event)
  const checked=await db.rpc('openwa_check_claimed_intake',{p_id:claim.id,p_token:claim.token,p_canonical:canonical,p_lifecycle:lifecycle})
  if(checked.error||checked.data!==true)throw Error('Intake route unavailable')
  const stopHeartbeat=startHeartbeat(db,claim,canonical,lifecycle)
  try{
   const response=await processReservedOpenWAWebhook(db,{accountId:claim.account_id,connectionId:claim.connection_id,envelope,processingToken:claim.token},canonical,true)
   if(response.ok)reason=null
  }finally{stopHeartbeat()}
 }catch{
  // No upstream data or exception text in logs; receipt evidence decides.
 }
 const {data:result,error:finishError}=await db.rpc('openwa_finish_signed_intake',{p_id:claim.id,p_token:claim.token,p_reason:reason})
 if(finishError||!['completed','review'].includes(result))throw Error('Intake outcome unconfirmed')
 return {claimed:1,completed:result==='completed'?1:0,review:result==='review'?1:0,disabled:false}
}
