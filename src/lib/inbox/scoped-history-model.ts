import { parseLocation,validId,mergePage,type InboxContext,type ScopedRow,type Page } from './scoped-list-model'
export type HistoryReaction={emoji:string;count:number;mine:boolean}
export type HistoryMessage={id:string;conversation_id:string;channel_id:string|null;provider:ScopedRow['provider'];sender_type:string;content_type:string;content_text:string|null;media_type:string|null;media_url:string|null;has_media:boolean;status:string;created_at:string|null;ingest_sequence:string|null;reply_to_message_id:string|null;reactions:HistoryReaction[]}
export type HistoryPage=Page<HistoryMessage>&{scope:ScopedRow['scope'];channel_id:string|null;conversation_id:string;observed_highwater:string|null;read_watermark:string|null;read_token:string|null}
export type HistoryScope=Pick<ScopedRow,'id'|'conversation_id'|'scope'|'channel_id'|'provider'>
export function historyPath(row:HistoryScope){
 const q=new URLSearchParams({scope:row.scope,limit:'50'})
 if(row.channel_id)q.set('channel_id',row.channel_id)
 return (row.scope==='unknown'?'unknown/'+row.conversation_id:'threads/'+row.id)+'/messages?'+q.toString()
}
export function historyKey(row:HistoryScope,ctx:InboxContext){
 return [ctx.accountId,ctx.userId,historyPath(row),row.conversation_id,row.provider].join(':')
}
export function validateHistory(page:HistoryPage,row:HistoryScope):boolean{
 return page.read_only===true&&page.scope===row.scope&&page.channel_id===row.channel_id&&page.conversation_id===row.conversation_id&&
 (page.next_cursor===null||typeof page.next_cursor==='string')&&Array.isArray(page.items)&&page.items.every(m=>m&&validId(m.id)&&m.conversation_id===row.conversation_id&&m.channel_id===row.channel_id&&m.provider===row.provider&&Array.isArray(m.reactions))
}
export function mergeHistory(previous:HistoryMessage[],next:HistoryMessage[]){return mergePage(previous,next)}
// Explicit click only. A background tab, legacy link, historical lane or stale
// URL cannot schedule a read, even before React finishes unmounting old detail.
export function canAcknowledge(row:HistoryScope,query:string,visible:boolean,focused:boolean,token:string|null){
 const loc=parseLocation(query)
 return Boolean(token&&visible&&focused&&row.scope==='active'&&row.channel_id&&!loc.invalid&&!loc.legacy&&loc.scope==='active'&&loc.thread===row.id&&(!loc.parent||loc.parent===row.conversation_id)&&(!loc.channel||loc.channel===row.channel_id))
}
export async function submitScopedRead(row:HistoryScope,ctx:InboxContext,token:string,signal:AbortSignal){
 const response=await fetch('/api/inbox/threads/'+row.id+'/read',{method:'POST',cache:'no-store',credentials:'same-origin',signal,headers:{'content-type':'application/json','x-wacrm-inbox-account':ctx.accountId,'x-wacrm-inbox-actor':ctx.userId},body:JSON.stringify({token})})
 if(!response.ok)throw new Error('Read acknowledgement failed')
 const body=await response.json()
 if(signal.aborted||body.thread_id!==row.id||body.channel_id!==row.channel_id)throw new Error('Read acknowledgement scope changed')
}
