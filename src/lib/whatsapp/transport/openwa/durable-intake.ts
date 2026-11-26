import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt,decrypt } from '@/lib/whatsapp/encryption'
import { isOpenWATestProject } from './environment'
import type { OpenWAWebhookEnvelope } from './webhook'

export const MAX_DURABLE_BODY_BYTES=24*1024*1024-4096
const MAX_CIPHER_BYTES=48*1024*1024
export function durableOpenWAIntakeEnabled(){
 return isOpenWATestProject()&&process.env.WACRM_OPENWA_DURABLE_INTAKE==='test_only'
}
export class DurableIntakeBodyTooLarge extends Error {}
/** Enforce the actual byte limit, not just an untrusted Content-Length. */
export async function readDurableWebhookBody(request:Request):Promise<string>{
 const declared=Number(request.headers.get('content-length')??0)
 if(declared>MAX_DURABLE_BODY_BYTES)throw new DurableIntakeBodyTooLarge()
 if(!request.body)return ''
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true})
 const parts:string[]=[];let total=0
 try{
  for(;;){
   const {done,value}=await reader.read()
   if(done)break
   total+=value.byteLength
   if(total>MAX_DURABLE_BODY_BYTES){await reader.cancel().catch(()=>{});throw new DurableIntakeBodyTooLarge()}
   parts.push(decoder.decode(value,{stream:true}))
  }
  parts.push(decoder.decode())
  return parts.join('')
 }finally{reader.releaseLock()}
}
/** Canonical key ordering for retries. Timestamp and delivery attempt metadata
 * are not part of event identity; signed message data is. */
function stable(value:unknown):string{
 if(value===null||typeof value!=='object')return JSON.stringify(value??null)
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']'
 const obj=value as Record<string,unknown>
 return '{'+Object.keys(obj).sort().map(k=>JSON.stringify(k)+':'+stable(obj[k])).join(',')+'}'
}
export function intakeDigest(e:OpenWAWebhookEnvelope){
 return createHash('sha256').update(stable([e.eventId,e.sessionId,e.instanceId??null,e.event,e.data??null])).digest('hex')
}
export type IntakeBinding={accountId:string;connectionId:string}
export function sealIntake(binding:IntakeBinding,envelope:OpenWAWebhookEnvelope){
 const ciphertext=encrypt(JSON.stringify({binding,envelope}))
 if(Buffer.byteLength(ciphertext)>MAX_CIPHER_BYTES)throw new DurableIntakeBodyTooLarge()
 return {ciphertext,digest:intakeDigest(envelope)}
}
const object=(v:unknown):Record<string,unknown>|null=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null
export type IntakeClaim={state:'claimed';id:string;account_id:string;connection_id:string;event_id:string;session_id:string;instance_id:string|null;canonical:boolean;token:string;ciphertext:string;digest:string}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
export function readIntakeClaim(value:unknown):IntakeClaim|null{
 const r=object(value)
 if(!r||r.state!=='claimed'||!uuid(r.id)||!uuid(r.account_id)||!uuid(r.connection_id)||!uuid(r.token)||
  typeof r.event_id!=='string'||typeof r.session_id!=='string'||!(r.instance_id===null||typeof r.instance_id==='string')||
  typeof r.canonical!=='boolean'||typeof r.ciphertext!=='string'||Buffer.byteLength(r.ciphertext)>MAX_CIPHER_BYTES||
  typeof r.digest!=='string'||!/^[0-9a-f]{64}$/.test(r.digest))return null
 return {state:'claimed',id:r.id,account_id:r.account_id,connection_id:r.connection_id,event_id:r.event_id,session_id:r.session_id,
  instance_id:r.instance_id,canonical:r.canonical,token:r.token,ciphertext:r.ciphertext,digest:r.digest}
}
export function openIntake(claim:IntakeClaim):OpenWAWebhookEnvelope{
 // No legacy unauthenticated CBC payload format accepted.
 if(claim.ciphertext.split(':').length!==3)throw Error('Intake evidence unavailable')
 const v=object(JSON.parse(decrypt(claim.ciphertext))),b=object(v?.binding),e=object(v?.envelope)
 if(!b||!e||b.accountId!==claim.account_id||b.connectionId!==claim.connection_id||e.eventId!==claim.event_id||
  e.sessionId!==claim.session_id||(e.instanceId??null)!==claim.instance_id||typeof e.event!=='string'||
  typeof e.timestamp!=='string'||!Number.isFinite(Date.parse(e.timestamp)))throw Error('Intake evidence unavailable')
 const envelope:OpenWAWebhookEnvelope={eventId:claim.event_id,sessionId:claim.session_id,instanceId:claim.instance_id??undefined,event:e.event,timestamp:e.timestamp,data:e.data}
 if(intakeDigest(envelope)!==claim.digest)throw Error('Intake evidence unavailable')
 return envelope
}
export async function enqueueVerifiedIntake(db:SupabaseClient,binding:IntakeBinding,envelope:OpenWAWebhookEnvelope,credentialVersion:string|undefined,canonical:boolean){
 if(!durableOpenWAIntakeEnabled()||!credentialVersion)throw Error('OpenWA webhook receipt could not be reserved')
 const sealed=sealIntake(binding,envelope)
 const {data,error}=await db.rpc('openwa_enqueue_signed_intake',{
  p_account:binding.accountId,p_connection:binding.connectionId,p_event:envelope.eventId,p_session:envelope.sessionId,p_instance:envelope.instanceId??null,
  p_credential_version:credentialVersion,p_canonical:canonical,p_digest:sealed.digest,p_ciphertext:sealed.ciphertext
 })
 if(error)throw Error('OpenWA webhook receipt could not be reserved')
 if(data==='conflict')throw Error('OpenWA webhook event identity conflict')
 if(data==='completed_duplicate')return {duplicate:true}
 if(data==='accepted'||data==='accepted_duplicate')return {duplicate:false,queued:true,queueDuplicate:data==='accepted_duplicate'}
 throw Error('OpenWA webhook receipt could not be reserved')
}
