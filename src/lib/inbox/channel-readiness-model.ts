// Safe administration projection, no phone, native ID, gateway URL or credentials.
import { validId } from './scoped-list-model'
import {isReviewedOpenWAVersion,type ReviewedOpenWAVersion} from './openwa-native-contract'
export type ReadinessGates={shadow:boolean;canonical:boolean;actions:boolean;durable:boolean}
export type ReadinessRow={
 id:string;provider:'openwa'|'meta_cloud';display_name:string|null;online:boolean;
 identity_verified:boolean;identity_candidate:boolean;channel_id:string|null;membership_id:string|null;
 identity_verified_at:string|null;last_closed_at:string|null;primary:boolean;
 credentials_present:boolean|null;signed_webhook_configured:boolean|null;engine:'whatsapp-web.js'|'baileys'|null;
 gateway_version:ReviewedOpenWAVersion|null;namespace_kind:'none'|'single_connection'|'shared_unclassified';
 namespace_verified_at:string|null;namespace_contract_verified:boolean;handover_blocked:boolean;held_count_capped:number
}
export type ReadinessPage={read_only:true;items:ReadinessRow[];next_after:string|null;gates:ReadinessGates}
type Obj=Record<string,unknown>
const object=(v:unknown):Obj|null=>v&&typeof v==='object'&&!Array.isArray(v)?v as Obj:null
const nullableId=(v:unknown):v is string|null=>v===null||validId(v)
const date=(v:unknown):v is string|null=>v===null||(typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v)))
export function normalizeReadinessRow(value:unknown):ReadinessRow|null{
 const r=object(value)
 if(!r||!validId(r.id)||(r.provider!=='openwa'&&r.provider!=='meta_cloud')||
   !(r.display_name===null||typeof r.display_name==='string'&&Array.from(r.display_name).length<=160)||
   typeof r.online!=='boolean'||typeof r.identity_verified!=='boolean'||typeof r.identity_candidate!=='boolean'||
   !nullableId(r.channel_id)||!nullableId(r.membership_id)||!date(r.identity_verified_at)||!date(r.last_closed_at)||
   typeof r.primary!=='boolean'||typeof r.namespace_contract_verified!=='boolean'||typeof r.handover_blocked!=='boolean'||
   !(r.credentials_present===null||typeof r.credentials_present==='boolean')||
   !(r.signed_webhook_configured===null||typeof r.signed_webhook_configured==='boolean')||
   !(r.engine===null||r.engine==='whatsapp-web.js'||r.engine==='baileys')||
   !(r.gateway_version===null||isReviewedOpenWAVersion(r.gateway_version))||
   !(r.namespace_kind==='none'||r.namespace_kind==='single_connection'||r.namespace_kind==='shared_unclassified')||
   !date(r.namespace_verified_at)||typeof r.held_count_capped!=='number'||!Number.isInteger(r.held_count_capped)||r.held_count_capped<0||r.held_count_capped>101) return null
 if((r.channel_id===null)!==(r.membership_id===null)||(r.identity_verified||r.primary)&&r.membership_id===null||
   r.namespace_contract_verified&&(r.namespace_kind!=='single_connection'||r.engine!=='whatsapp-web.js'||!isReviewedOpenWAVersion(r.gateway_version)||r.namespace_verified_at===null))return null
 if(r.provider==='openwa'&&(r.credentials_present===null||r.signed_webhook_configured===null))return null
 // Explicit allowlist; never forward unexpected properties even from the RPC.
 return {id:r.id,provider:r.provider,display_name:r.display_name,online:r.online,identity_verified:r.identity_verified,identity_candidate:r.identity_candidate,
   channel_id:r.channel_id,membership_id:r.membership_id,identity_verified_at:r.identity_verified_at,last_closed_at:r.last_closed_at,primary:r.primary,
   credentials_present:r.credentials_present,signed_webhook_configured:r.signed_webhook_configured,engine:r.engine,gateway_version:r.gateway_version,
   namespace_kind:r.namespace_kind,namespace_verified_at:r.namespace_verified_at,namespace_contract_verified:r.namespace_contract_verified,
   handover_blocked:r.handover_blocked,held_count_capped:r.held_count_capped}
}
export function normalizeReadinessPage(value:unknown):ReadinessPage|null{
 const p=object(value),g=object(p?.gates)
 if(!p||p.read_only!==true||!Array.isArray(p.items)||p.items.length>20||!nullableId(p.next_after)||
   !g||typeof g.shadow!=='boolean'||typeof g.canonical!=='boolean'||typeof g.actions!=='boolean'||typeof g.durable!=='boolean')return null
 const items=p.items.map(normalizeReadinessRow)
 if(items.some(r=>r===null))return null
 const rows=items as ReadinessRow[]
 if(new Set(rows.map(r=>r.id)).size!==rows.length||p.next_after!==null&&p.next_after!==rows.at(-1)?.id)return null
 return {read_only:true,items:rows,next_after:p.next_after,gates:{shadow:g.shadow,canonical:g.canonical,actions:g.actions,durable:g.durable}}
}
export type ReadinessReason='readinessOffline'|'readinessNoCandidate'|'readinessNoCredentials'|'readinessNoWebhook'|'readinessIdentityMissing'|'readinessNamespaceMissing'|'readinessSharedUnverified'|'readinessPrimaryMissing'|'readinessHandoverBlocked'|'readinessContractMismatch'
export function readinessReasons(row:ReadinessRow):ReadinessReason[]{
 const reasons:ReadinessReason[]=[]
 if(!row.online)reasons.push('readinessOffline')
 if(!row.identity_candidate)reasons.push('readinessNoCandidate')
 if(row.provider==='openwa'){
  if(!row.credentials_present)reasons.push('readinessNoCredentials')
  if(!row.signed_webhook_configured)reasons.push('readinessNoWebhook')
 }
 if(!row.identity_verified)reasons.push('readinessIdentityMissing')
 if(row.provider==='openwa'){
  if(row.namespace_kind==='none')reasons.push('readinessNamespaceMissing')
  else if(row.namespace_kind==='shared_unclassified')reasons.push('readinessSharedUnverified')
  else if(!row.namespace_contract_verified)reasons.push('readinessContractMismatch')
  if(!row.primary)reasons.push('readinessPrimaryMissing')
  if(row.handover_blocked)reasons.push('readinessHandoverBlocked')
 }
 return reasons
}
export function readinessCapabilities(row:ReadinessRow,gates:ReadinessGates){
 const verifyIdentity=gates.shadow&&row.online&&row.identity_candidate&&(row.provider==='meta_cloud'||row.credentials_present===true)
 return {verifyIdentity:verifyIdentity&&!row.identity_verified,
  verifyPrimary:verifyIdentity&&row.provider==='openwa'&&row.signed_webhook_configured===true&&!row.handover_blocked,
  revoke:gates.shadow&&!gates.canonical&&!gates.actions&&!gates.durable&&row.provider==='openwa'&&row.membership_id!==null}
}
