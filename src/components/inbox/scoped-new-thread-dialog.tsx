'use client'
import {useEffect,useState} from 'react'
import {useTranslations} from 'next-intl'
import {Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle} from '@/components/ui/dialog'
import {Button} from '@/components/ui/button'
import {createClient} from '@/lib/supabase/client'
import {fetchInbox,type Channel,type Connection,type InboxContext,type Page} from '@/lib/inbox/scoped-list-model'
type ContactChoice={id:string;name:string|null;phone:string}
type Props={ctx:InboxContext;open:boolean;onOpenChange:(value:boolean)=>void;onCreated:(href:string)=>void}
const headers=(ctx:InboxContext)=>({'content-type':'application/json','x-wacrm-inbox-account':ctx.accountId,'x-wacrm-inbox-actor':ctx.userId})
// No new recipient or provider call here; select only an existing CRM
// contact and a verified currently ready sender from this account/channel.
export function ScopedNewThreadDialog({ctx,open,onOpenChange,onCreated}:Props){
 const t=useTranslations('Inbox.scoped')
 const [channels,setChannels]=useState<Channel[]>([])
 const [connections,setConnections]=useState<Connection[]>([])
 const [contacts,setContacts]=useState<ContactChoice[]>([])
 const [channelId,setChannelId]=useState('')
 const [connectionId,setConnectionId]=useState('')
 const [contactId,setContactId]=useState('')
 const [search,setSearch]=useState('')
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 useEffect(()=>{
  if(!open)return
  const ctl=new AbortController()
  void fetchInbox<Page<Channel>>('channels?scope=active&limit=50',ctx,ctl.signal)
   .then(v=>{if(!ctl.signal.aborted)setChannels(v.items.filter(c=>c.scope==='active'&&c.ready))})
   .catch(()=>{if(!ctl.signal.aborted)setChannels([])})
  return()=>ctl.abort()
 },[open,ctx.accountId,ctx.userId])
 useEffect(()=>{
  const ctl=new AbortController()
  if(!open||!channelId)return()=>ctl.abort()
  void fetchInbox<Page<Connection>>('connections?scope=active&channel_id='+encodeURIComponent(channelId)+'&limit=50',ctx,ctl.signal)
   .then(v=>{if(!ctl.signal.aborted)setConnections(v.items.filter(c=>c.channel_id===channelId&&!c.archived&&c.ready))})
   .catch(()=>{if(!ctl.signal.aborted)setConnections([])})
  return()=>ctl.abort()
 },[open,channelId,ctx.accountId,ctx.userId])
 useEffect(()=>{
  if(!open)return
  let cancelled=false
  const timer=setTimeout(()=>{
   const db=createClient()
   const term=search.trim().replace(/[%_,()\\]/g,'').slice(0,60)
   let q=db.from('contacts').select('id,name,phone').eq('account_id',ctx.accountId).order('name',{ascending:true}).limit(30)
   if(term)q=q.or('name.ilike.%'+term+'%,phone.ilike.%'+term+'%')
   void (async()=>{try{const {data,error}=await q;if(!cancelled)setContacts(error?[]:(data??[]) as ContactChoice[])}
    catch{if(!cancelled)setContacts([])}})()
  },230)
  return()=>{cancelled=true;clearTimeout(timer)}
 },[open,search,ctx.accountId])
 const channel=channels.find(c=>c.id===channelId)
 const connection=connections.find(c=>c.id===connectionId&&c.provider===channel?.provider&&c.ready)
 async function create(){
  if(!channel||!connection||!contactId||busy)return
  setBusy(true);setError('')
  try{
   const response=await fetch('/api/inbox/threads',{method:'POST',credentials:'same-origin',cache:'no-store',headers:headers(ctx),
    body:JSON.stringify({contactId,channelId,connectionId,provider:channel.provider})})
   const result=await response.json()
   if(!response.ok||typeof result.thread_id!=='string'||result.channel_id!==channelId)throw Error('scope')
   const query=new URLSearchParams({scope:'active',channel:channelId,thread:result.thread_id})
   onOpenChange(false);onCreated('/inbox?'+query.toString())
  }catch{setError(t('actionNewThreadFailed'))}
  finally{setBusy(false)}
 }
 return <Dialog open={open} onOpenChange={onOpenChange}>
  <DialogContent className="max-h-[min(90dvh,50rem)] overflow-y-auto pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-w-lg">
   <DialogHeader><DialogTitle>{t('actionNewThread')}</DialogTitle><DialogDescription>{t('actionNewThreadNotice')}</DialogDescription></DialogHeader>
   <div className="space-y-3">
    <label className="block space-y-1 text-xs"><span>{t('chooseChannel')}</span>
     <select className="min-h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-base sm:text-sm" value={channelId} disabled={busy} onChange={e=>{setChannelId(e.target.value);setConnectionId('');setConnections([])}}>
      <option value="">{t('chooseChannel')}</option>
      {channels.map(c=><option value={c.id} key={c.id}>{(c.display_name||c.own_phone||c.provider)+' · '+c.provider}</option>)}
     </select>
    </label>
    <label className="block space-y-1 text-xs"><span>{t('actionChooseSender')}</span>
     <select className="min-h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-base sm:text-sm" value={connectionId} disabled={!channelId||busy} onChange={e=>setConnectionId(e.target.value)}>
      <option value="">{t('actionChooseSender')}</option>
      {connections.map(c=><option key={c.id} value={c.id}>{(c.display_name||c.id.slice(0,8))+' · '+(c.is_primary?t('primary'):t('actionSecondary'))}</option>)}
     </select>
    </label>
    <label className="block space-y-1 text-xs"><span>{t('actionFindContact')}</span>
     <input className="min-h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-base sm:text-sm" value={search} maxLength={60} onChange={e=>{setSearch(e.target.value);setContactId('')}} placeholder={t('search')}/>
    </label>
    <label className="block space-y-1 text-xs"><span>{t('actionExistingContact')}</span>
     <select className="min-h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-base sm:text-sm" value={contactId} disabled={busy} onChange={e=>setContactId(e.target.value)}>
      <option value="">{t('actionExistingContact')}</option>
      {contacts.map(c=><option key={c.id} value={c.id}>{(c.name||c.phone)+' · '+c.phone}</option>)}
     </select>
    </label>
   </div>
   {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
   <DialogFooter><Button className="min-h-11" variant="outline" onClick={()=>onOpenChange(false)} disabled={busy}>{t('actionCancelReply')}</Button><Button className="min-h-11" disabled={!connection||!contactId||busy} onClick={()=>void create()}>{busy?t('loading'):t('actionOpenThread')}</Button></DialogFooter>
  </DialogContent>
 </Dialog>
}
