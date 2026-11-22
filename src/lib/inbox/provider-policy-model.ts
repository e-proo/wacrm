import type { WhatsAppProvider,WhatsAppMediaKind } from '@/lib/whatsapp/transport/types'
export const WINDOW_MS=24*60*60*1000
export const MEDIA_KINDS: readonly WhatsAppMediaKind[]=['image','video','document','audio']
export type PolicyReason='role_read_only'|'sender_selection_required'|'connection_not_ready'|'recipient_unverified'|'policy_unavailable'|'operational_denied'|'manual_pause'|'failure_circuit_open'|'pilot_recipient_not_allowlisted'|'hourly_cap'|'daily_cap'|'first_touch_daily_cap'|'pilot_workload_hourly_cap'|'pilot_workload_daily_cap'|'channel_hourly_cap'|'channel_daily_cap'|'channel_first_touch_cap'|'channel_policy_unavailable'|'meta_window_closed'
export type PolicyContext={thread_id:string;conversation_id:string;channel_id:string;provider:WhatsAppProvider;connection_id:string|null;membership_id:string|null;ready:boolean;can_operate:boolean;recipient:string|null;contact_phone:string|null;last_inbound_at:string|null;server_now:string}
export type InboxCapabilities={thread_id:string;channel_id:string;provider:WhatsAppProvider;connection_id:string|null;ready:boolean;server_now:string;last_inbound_at:string|null;window_expires_at:string|null;window_state:'open'|'closed'|'not_applicable';blocked_reason:PolicyReason|null;may_send_text:boolean;may_send_media:boolean;may_send_template:boolean;may_send_interactive:boolean;may_reply:boolean;may_react:boolean;may_read:boolean;media_kinds:readonly WhatsAppMediaKind[];caption_limit:number;dispatch_enabled:boolean;membership_id?:string|null}
export function deriveInboxCapabilities(c:PolicyContext,policyDenial:PolicyReason|null=null):InboxCapabilities{
 const now=Date.parse(c.server_now),last=c.last_inbound_at?Date.parse(c.last_inbound_at):NaN
 const trusted=c.provider==='meta_cloud'&&Number.isFinite(last)&&Number.isFinite(now)&&last<=now
 const expires=trusted?last+WINDOW_MS:NaN
 const open=trusted&&now<expires
 const reason:PolicyReason|null=!c.can_operate?'role_read_only':!c.connection_id||!c.membership_id?'sender_selection_required':!c.ready?'connection_not_ready':!c.recipient?'recipient_unverified':!Number.isFinite(now)?'policy_unavailable':policyDenial
 const allowed=reason===null,meta=c.provider==='meta_cloud',free=allowed&&(!meta||open)
 return {thread_id:c.thread_id,channel_id:c.channel_id,provider:c.provider,connection_id:c.connection_id,ready:c.ready,server_now:c.server_now,last_inbound_at:trusted?c.last_inbound_at:null,window_expires_at:trusted?new Date(expires).toISOString():null,window_state:meta?(open?'open':'closed'):'not_applicable',blocked_reason:reason??(meta&&!open?'meta_window_closed':null),may_send_text:free,may_send_media:free,may_send_template:allowed&&meta,may_send_interactive:free&&meta,may_reply:free,may_react:free&&meta,may_read:allowed,media_kinds:free?MEDIA_KINDS:[],caption_limit:1024,dispatch_enabled:false}
}
export function allowsContent(c:InboxCapabilities,kind:string):boolean{
 return kind==='text'?c.may_send_text:kind==='template'?c.may_send_template:kind==='interactive'?c.may_send_interactive:(MEDIA_KINDS as readonly string[]).includes(kind)?c.may_send_media:false
}
