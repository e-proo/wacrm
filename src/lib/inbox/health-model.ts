// Only aggregate, non-PII metrics are permitted in an Inbox health response.
export const INBOX_HEALTH_KEYS=['threads','active_memberships','action_uncertain','action_pending_over_5m','effect_claimed_over_5m','effect_review','effect_awaiting_source','effect_pending','recent_memberships','recent_orphan_memberships'] as const
export type InboxHealthKey=typeof INBOX_HEALTH_KEYS[number]
export type InboxHealthCounts=Record<InboxHealthKey,number>
export type InboxHealthReport={sampled_at:string;window:'24h';counts:InboxHealthCounts;signals:{projection_mismatch:boolean;reconciliation_needed:boolean;backlog_attention:boolean};thresholds:{pending_minutes:5;orphan_count:0;uncertain_count:0}}
export function normalizeInboxHealth(data:unknown):InboxHealthReport|null{
 if(!data||typeof data!=='object'||Array.isArray(data))return null
 const raw=data as Record<string,unknown>
 if(raw.read_only!==true||raw.window!=='24h'||typeof raw.sampled_at!=='string'||!Number.isFinite(Date.parse(raw.sampled_at)))return null
 const counts={} as InboxHealthCounts
 for(const key of INBOX_HEALTH_KEYS){
  const n=raw[key]
  if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0)return null
  counts[key]=n
 }
 return {sampled_at:raw.sampled_at,window:'24h',counts,signals:{
   projection_mismatch:counts.recent_orphan_memberships>0,
   reconciliation_needed:counts.action_uncertain>0||counts.effect_review>0,
   backlog_attention:counts.action_pending_over_5m>0||counts.effect_claimed_over_5m>0||counts.effect_awaiting_source>0,
  },thresholds:{pending_minutes:5,orphan_count:0,uncertain_count:0}}
}
