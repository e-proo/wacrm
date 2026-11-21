// Client-safe routing, preference and request helpers. Never infer a sender.
export type InboxScope = 'active'|'historical'|'unknown'
export type InboxContext = {accountId:string;userId:string}
export type InboxSelection = {scope:InboxScope;channel:string|null;thread:string|null;parent:string|null;connection:string|null;legacy:boolean;invalid:boolean}
export type InboxFilters = {status:'all'|'open'|'pending'|'closed';unread:boolean;assignment:'all'|'mine'|'unassigned';tags:string[];company:string;search:string}
export type ScopedRow = {id:string;conversation_id:string;channel_id:string|null;provider:'openwa'|'meta_cloud'|null;scope:InboxScope;read_only:true;route_ready:boolean;status:string;preview:string|null;last_message_at:string|null;unread_count_known:number|null;legacy_crm_unread?:number;channel_name?:string|null;own_phone?:string|null;assigned_agent_name?:string|null;assigned_to_me?:boolean;contact:{id:string;name:string|null;phone:string;company:string|null}}
export type Channel = {id:string;provider:'openwa'|'meta_cloud';display_name:string|null;own_phone:string|null;scope:'active'|'historical';ready:boolean;primary_connection_id:string|null;ready_sessions:number;known_unread:number}
export type Connection={id:string;provider:'openwa'|'meta_cloud';display_name:string|null;status:string;archived:boolean;channel_id:string|null;identity_state:string;membership_state:string;is_primary:boolean;ready:boolean;registry_online:boolean}
export type Counts={threads:number;known_unread:number;known_unread_threads:number;legacy_lane_unread:number;legacy_crm_unread:number;lane_messages:number;unresolved_messages:number;legacy_unread_is_additive:false}
export type Page<T>={items:T[];next_cursor:string|null;read_only:true}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const validId=(v:unknown):v is string=>typeof v==='string'&&uuid.test(v)
export const defaultFilters:InboxFilters={status:'all',unread:false,assignment:'all',tags:[],company:'',search:''}
export function parseLocation(query:string):InboxSelection {
 const q=new URLSearchParams(query)
 const raw=q.get('scope'), channel=q.get('channel'), thread=q.get('thread'), parent=q.get('c'), connection=q.get('connection')
 const scope:InboxScope=raw==='historical'||raw==='unknown'?raw:'active'
 const invalid=(raw!==null&&!['active','historical','unknown'].includes(raw))||[channel,thread,parent,connection].some(v=>v!==null&&!validId(v))||
  ['scope','channel','thread','c','connection'].some(k=>q.getAll(k).length>1)||
  (scope==='unknown'&&Boolean(channel||thread))||Boolean(connection&&!parent)
 return {scope,channel:channel?.toLowerCase()??null,thread:thread?.toLowerCase()??null,parent:parent?.toLowerCase()??null,connection:connection?.toLowerCase()??null,legacy:Boolean(parent&&(connection||!thread&&raw!=='unknown')),invalid}
}
export function selectionHref(scope:InboxScope,channel:string|null,row?:ScopedRow):string{
 const q=new URLSearchParams({scope:row?.scope??scope})
 const exact=(row?.scope??scope)==='unknown'?null:channel
 if(exact)q.set('channel',exact)
 if(row){q.set('c',row.conversation_id);if(row.scope!=='unknown')q.set('thread',row.id)}
 return '/inbox?'+q.toString()
}
export function listQuery(scope:InboxScope,channel:string|null,filters:InboxFilters=defaultFilters,exact?:string):string {
 const q=new URLSearchParams({scope,limit:'30'})
 if(channel&&scope!=='unknown')q.set('channel_id',channel)
 if(filters.status!=='all')q.set('status',filters.status)
 if(filters.unread)q.set('unread','true')
 if(filters.assignment!=='all')q.set('assignment',filters.assignment)
 if(filters.tags.length)q.set('tags',[...filters.tags].sort().join(','))
 if(filters.company.trim())q.set('company',filters.company.trim())
 if(filters.search.trim())q.set('search',filters.search.trim())
 if(exact)q.set('thread_id',exact)
 return q.toString()
}
export function preferenceKey(ctx:InboxContext){return 'wacrm:scoped-inbox:v1:'+ctx.accountId+':'+ctx.userId}
export function readPreference(value:string|null):{scope:InboxScope;channel:string|null}|null{
 try{const x=JSON.parse(value??'null');if(!x||!['active','historical','unknown'].includes(x.scope)||(x.channel!==null&&!validId(x.channel))||x.scope==='unknown'&&x.channel!==null)return null;return {scope:x.scope,channel:x.channel}}catch{return null}
}
export function sameScope(row:ScopedRow,scope:InboxScope,channel:string|null){return row.scope===scope&&(scope==='unknown'?row.channel_id===null:validId(row.channel_id)&&(!channel||row.channel_id===channel))}
export function selectExact(rows:ScopedRow[],loc:InboxSelection):ScopedRow|null {
 if(loc.invalid)return null
 return rows.find(r=>sameScope(r,loc.scope,loc.channel)&&(!loc.parent||r.conversation_id===loc.parent)&&(loc.scope==='unknown'?r.id===loc.parent:r.id===loc.thread))??null
}
export function mergePage<T extends {id:string}>(old:T[],next:T[]):T[]{
 const map=new Map(old.map(x=>[x.id,x]))
 for(const row of next)map.set(row.id,row)
 return [...map.values()]
}
export async function fetchInbox<T>(path:string,ctx:InboxContext,signal:AbortSignal):Promise<T>{
 const response=await fetch('/api/inbox/'+path,{method:'GET',cache:'no-store',credentials:'same-origin',signal,headers:{'x-wacrm-inbox-account':ctx.accountId,'x-wacrm-inbox-actor':ctx.userId}})
 if(!response.ok)throw new Error('Inbox read failed')
 const body=await response.json()
 if(signal.aborted||body?.read_only!==true)throw new Error('Inbox read cancelled or invalid')
 return body as T
}
export function pagePath(path:string,cursor:string|null){
 if(!cursor)return path
 return path+(path.includes('?')?'&':'?')+'cursor='+encodeURIComponent(cursor)
}
