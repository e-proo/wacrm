import { validId } from './scoped-list-model'
export const REVIEW_REASONS=['missing_verified_epoch','event_only_identity','namespace_unverified','peer_conflict','receipt_conflict','legacy_collision','outbound_echo_unproven','reaction_unproven','source_unconfirmed','payload_changed','primary_unavailable'] as const
export const REVIEW_DECISIONS=['busy','unverified','duplicate','restore','closed'] as const
export const REVIEW_OUTCOMES=['restored_history','duplicate_confirmed','closed_unverified','system_resolved'] as const
export const REVIEW_ACTIONS=['restore','duplicate','close_unverified'] as const
const kinds=['text','image','video','audio','document','reaction','sticker','location','interactive','template','other'] as const
export type ReviewReason=typeof REVIEW_REASONS[number]
export type ReviewDecision=typeof REVIEW_DECISIONS[number]
export type ReviewOutcome=typeof REVIEW_OUTCOMES[number]
export type ReviewAction=typeof REVIEW_ACTIONS[number]
export type ReviewRow={id:string;connection_id:string;display_name:string|null;reason:ReviewReason;created_at:string;resolved_at:string|null;decision:ReviewDecision;outcome:ReviewOutcome|null;preview:string|null;message_kind:typeof kinds[number]}
export type ReviewPage={read_only:true;items:ReviewRow[];next_after:string|null;maintenance_ready:boolean;closed:boolean}
const object=(v:unknown):Record<string,unknown>|null=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null
const oneOf=<T extends string>(v:unknown,values:readonly T[]):v is T=>typeof v==='string'&&(values as readonly string[]).includes(v)
const date=(v:unknown):v is string=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v))
const small=(v:unknown):v is string|null=>v===null||typeof v==='string'&&Array.from(v).length<=160
export function normalizeReviewRow(value:unknown):ReviewRow|null{
 const r=object(value)
 if(!r||!validId(r.id)||!validId(r.connection_id)||!small(r.display_name)||!oneOf(r.reason,REVIEW_REASONS)||!date(r.created_at)||
  !(r.resolved_at===null||date(r.resolved_at))||!oneOf(r.decision,REVIEW_DECISIONS)||!(r.outcome===null||oneOf(r.outcome,REVIEW_OUTCOMES))||
  !small(r.preview)||!oneOf(r.message_kind,kinds))return null
 if((r.decision==='closed')!==(r.resolved_at!==null)||(r.outcome!==null)!==(r.decision==='closed')||r.message_kind!=='text'&&r.preview!==null)return null
 return {id:r.id,connection_id:r.connection_id,display_name:r.display_name,reason:r.reason,created_at:r.created_at,resolved_at:r.resolved_at,
  decision:r.decision,outcome:r.outcome,preview:r.preview,message_kind:r.message_kind}
}
export function normalizeReviewPage(value:unknown):ReviewPage|null{
 const p=object(value)
 if(!p||p.read_only!==true||!Array.isArray(p.items)||p.items.length>20||
  !(p.next_after===null||validId(p.next_after))||typeof p.maintenance_ready!=='boolean'||typeof p.closed!=='boolean')return null
 const items=p.items.map(normalizeReviewRow)
 if(items.some(r=>r===null))return null
 const rows=items as ReviewRow[]
 if(rows.some(r=>(r.decision==='closed')!==p.closed)||new Set(rows.map(r=>r.id)).size!==rows.length||
  p.next_after!==null&&p.next_after!==rows.at(-1)?.id)return null
 return {read_only:true,items:rows,next_after:p.next_after,maintenance_ready:p.maintenance_ready,closed:p.closed}
}
export function reviewAction(row:ReviewRow,maintenance:boolean):ReviewAction|null{
 if(!maintenance||row.resolved_at!==null)return null
 return row.decision==='restore'?'restore':row.decision==='duplicate'?'duplicate':row.decision==='unverified'?'close_unverified':null
}
