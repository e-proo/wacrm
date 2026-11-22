import type {InboxContext} from './scoped-list-model'

// Deliberately tab-memory only: NO localStorage, sessionStorage, IndexedDB,
// server-side persistence or upload credentials. The action UUID/status are
// handled separately by the immutable request journal.
export type ScopedDraft={mode:'text'|'media'|'template'|'interactive';text:string;caption:string}
type Stored={value:ScopedDraft;created:number}
const entries=new Map<string,Stored>()
const MAX=24,TTL_MS=45*60*1000
export const emptyScopedDraft=():ScopedDraft=>({mode:'text',text:'',caption:''})
export function scopedDraftKey(ctx:InboxContext,thread:string,channel:string|null){
 return [ctx.accountId,ctx.userId,thread,channel??''].join(':')
}
function prune(now:number){
 for(const [key,v] of entries)if(now-v.created>=TTL_MS||now<v.created)entries.delete(key)
 while(entries.size>MAX)entries.delete(entries.keys().next().value!)
}
export function getScopedDraft(key:string,now=Date.now()):ScopedDraft{
 prune(now)
 const stored=entries.get(key)
 return stored?{...stored.value}:emptyScopedDraft()
}
export function saveScopedDraft(key:string,value:ScopedDraft,now=Date.now()){
 prune(now)
 const clean:ScopedDraft={
  mode:['text','media','template','interactive'].includes(value.mode)?value.mode:'text',
  text:value.text.slice(0,4096),caption:value.caption.slice(0,1024),
 }
 if(!clean.text&&!clean.caption&&clean.mode==='text'){entries.delete(key);return}
 entries.delete(key);entries.set(key,{value:clean,created:now});prune(now)
}
export function clearScopedDraft(key:string){entries.delete(key)}
export function clearAccountScopedDrafts(ctx:InboxContext){
 const prefix=ctx.accountId+':'+ctx.userId+':'
 for(const key of entries.keys())if(key.startsWith(prefix))entries.delete(key)
}
export function containsUnsentDraft(v:ScopedDraft){return Boolean(v.text.trim()||v.caption.trim())}
