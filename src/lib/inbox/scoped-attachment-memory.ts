import type {InboxContext} from './scoped-list-model'

export type ScopedAttachment={kind:'image'|'video'|'audio'|'document';url:string;path:string;filename:string}
type Entry={value:ScopedAttachment;at:number}
const staged=new Map<string,Entry>()
const TTL=45*60*1000,MAX=24
function prune(now:number){
 for(const [key,entry] of staged)if(now<entry.at||now-entry.at>=TTL)staged.delete(key)
 while(staged.size>MAX)staged.delete(staged.keys().next().value!)
}
// Volatile tab memory only. Do not delete storage on expiry, navigation,
// logout or acceptance: a previously submitted object may still be in use.
export function getScopedAttachment(key:string,now=Date.now()):ScopedAttachment|null{
 prune(now)
 const value=staged.get(key)?.value
 return value?{...value}:null
}
export function saveScopedAttachment(key:string,value:ScopedAttachment|null,now=Date.now()){
 prune(now)
 staged.delete(key)
 if(value){
  const account=key.split(':')[0]
  if(!account||!value.path.startsWith('account-'+account+'/'))return
  staged.set(key,{value:{...value},at:now});prune(now)
 }
}
export function clearAccountScopedAttachments(ctx:InboxContext){
 const prefix=ctx.accountId+':'+ctx.userId+':'
 for(const key of staged.keys())if(key.startsWith(prefix))staged.delete(key)
}
