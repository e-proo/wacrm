import type {HistoryMessage} from './scoped-history-model'
import type {InboxCapabilities} from './provider-policy-model'

// The browser's local day is used consistently for grouping and display.
export function conversationDay(value:string|null,locale:string):string|null{
 if(!value)return null
 const date=new Date(value)
 return Number.isFinite(date.getTime())?new Intl.DateTimeFormat(locale,{year:'numeric',month:'long',day:'numeric'}).format(date):null
}
export function quotePreview(message:Pick<HistoryMessage,'content_text'|'content_type'>,fallback:string){
 return (message.content_text?.trim()||(message.content_type?'['+message.content_type+']':fallback)).slice(0,240)
}
export function metaWindow(c:InboxCapabilities|null,elapsedMs:number){
 if(c?.provider!=='meta_cloud')return null
 const expires=Date.parse(c.window_expires_at??''),now=Date.parse(c.server_now)
 const remaining=Number.isFinite(expires)&&Number.isFinite(now)&&Number.isFinite(elapsedMs)?Math.max(0,expires-now-Math.max(0,elapsedMs)):0
 return {remaining,open:c.window_state==='open'&&remaining>0}
}
export function sameReplyLane(message:HistoryMessage,conversationId:string,channelId:string|null,provider:HistoryMessage['provider']){
 return Boolean(channelId&&message.conversation_id===conversationId&&message.channel_id===channelId&&message.provider===provider)
}
