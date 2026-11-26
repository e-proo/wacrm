import {validId} from './scoped-list-model'
export const INTAKE_METRICS=['pending','running','review','closed_unverified','completed_24h','mode_blocked','review_blocked','oldest_pending_seconds','oldest_running_seconds','retained_events','retained_bytes','legacy_unfinished'] as const
export const INTAKE_LATENCY=['count','avg_queue_ms','avg_processing_ms','max_processing_ms'] as const
export const INTAKE_REASONS=['binding_changed','processing_uncertain','lease_expired','payload_unavailable'] as const
export type IntakeReason=typeof INTAKE_REASONS[number]
export type IntakeHealth=Record<typeof INTAKE_METRICS[number],number>&{latency_sample:Record<typeof INTAKE_LATENCY[number],number>}
export type IntakeReviewRow={id:string;connection_id:string;display_name:string|null;state:'review'|'closed_unverified';reason:IntakeReason;received_at:string;finished_at:string;closed_at:string|null;canonical:boolean}
export type IntakeHealthPage={read_only:true;health:IntakeHealth;items:IntakeReviewRow[];next_after:string|null;enabled:boolean;canonical:boolean;maintenance_ready:boolean}
const object=(v:unknown):Record<string,unknown>|null=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0
const date=(v:unknown):v is string=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v))
export function normalizeIntakeHealth(value:unknown):IntakeHealth|null{
 const r=object(value),sample=object(r?.latency_sample)
 if(!r||!sample)return null
 const metrics={} as Record<typeof INTAKE_METRICS[number],number>,latency={} as Record<typeof INTAKE_LATENCY[number],number>
 for(const k of INTAKE_METRICS){const n=r[k];if(!count(n))return null;metrics[k]=n}
 for(const k of INTAKE_LATENCY){const n=sample[k];if(!count(n))return null;latency[k]=n}
 if(latency.count>1000||metrics.retained_events>500||metrics.retained_bytes>134217728||metrics.mode_blocked>metrics.pending||metrics.review_blocked>metrics.pending)return null
 return {...metrics,latency_sample:latency}
}
export function normalizeIntakeReviewRow(value:unknown):IntakeReviewRow|null{
 const r=object(value)
 if(!r||!validId(r.id)||!validId(r.connection_id)||!(r.display_name===null||typeof r.display_name==='string'&&Array.from(r.display_name).length<=160)||
  (r.state!=='review'&&r.state!=='closed_unverified')||typeof r.reason!=='string'||!(INTAKE_REASONS as readonly string[]).includes(r.reason)||
  !date(r.received_at)||!date(r.finished_at)||!(r.closed_at===null||date(r.closed_at))||typeof r.canonical!=='boolean'||(r.state==='closed_unverified')!==(r.closed_at!==null))return null
 return {id:r.id,connection_id:r.connection_id,display_name:r.display_name,state:r.state,reason:r.reason as IntakeReason,received_at:r.received_at,finished_at:r.finished_at,closed_at:r.closed_at,canonical:r.canonical}
}
export function normalizeIntakeHealthPage(value:unknown):IntakeHealthPage|null{
 const r=object(value),health=normalizeIntakeHealth(r?.health)
 if(!r||r.read_only!==true||!health||!Array.isArray(r.items)||r.items.length>20||
  !(r.next_after===null||validId(r.next_after))||typeof r.enabled!=='boolean'||typeof r.canonical!=='boolean'||typeof r.maintenance_ready!=='boolean'||
  r.maintenance_ready&&(r.enabled||r.canonical))return null
 const rows=r.items.map(normalizeIntakeReviewRow)
 if(rows.some(x=>x===null))return null
 const items=rows as IntakeReviewRow[]
 if(new Set(items.map(x=>x.id)).size!==items.length||r.next_after!==null&&r.next_after!==items.at(-1)?.id)return null
 return {read_only:true,health,items,next_after:r.next_after,enabled:r.enabled,canonical:r.canonical,maintenance_ready:r.maintenance_ready}
}
