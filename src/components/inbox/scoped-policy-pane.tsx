'use client'
import {useEffect,useState} from 'react'
import {useTranslations} from 'next-intl'
import {fetchInbox,type InboxContext,type ScopedRow} from '@/lib/inbox/scoped-list-model'
import type {InboxCapabilities} from '@/lib/inbox/provider-policy-model'
type Snapshot={key:string;value:InboxCapabilities|null;received:number;remaining:number}
const elapsed=(ms:number)=>Math.max(0,Math.ceil(ms/1000))
const format=(seconds:number)=>[Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':')
export function ScopedPolicyPane({row,ctx,revision}:{row:ScopedRow;ctx:InboxContext;revision:number}){
 const t=useTranslations('Inbox.scoped')
 const path='threads/'+row.id+'/capabilities?channel_id='+row.channel_id
 const key=[ctx.accountId,ctx.userId,path,revision].join(':')
 const [state,setState]=useState<Snapshot|null>(null),[tick,setTick]=useState(0)
 const {accountId,userId}=ctx
 const id=row.id,channel=row.channel_id,provider=row.provider,scope=row.scope
 useEffect(()=>{
  if(scope!=='active'||!channel)return
  const controller=new AbortController(),started=performance.now()
  void fetchInbox<{capabilities:InboxCapabilities}>(path,{accountId,userId},controller.signal).then(body=>{
   const c=body.capabilities
   if(!c||c.thread_id!==id||c.channel_id!==channel||c.provider!==provider||typeof c.dispatch_enabled!=='boolean')throw Error('Policy scope changed')
   if(!controller.signal.aborted){
    const received=performance.now()
    const remaining=c.window_expires_at?Math.max(0,Date.parse(c.window_expires_at)-Date.parse(c.server_now)-(received-started)):0
    setState({key,value:c,received,remaining});setTick(received)
   }
  }).catch(()=>{if(!controller.signal.aborted)setState({key,value:null,received:0,remaining:0})})
  const timer=setInterval(()=>setTick(performance.now()),1000)
  return ()=>{controller.abort();clearInterval(timer)}
 },[key,path,accountId,userId,id,channel,provider,scope])
 if(scope!=='active'||!channel)return null
 const current=state?.key===key?state:null,c=current?.value
 const remaining=current?elapsed(current.remaining-Math.max(0,tick-current.received)):0
 const expired=c?.provider==='meta_cloud'&&c.window_state==='open'&&remaining===0
 return <section className="shrink-0 border-b border-border bg-card px-4 py-2 text-xs" aria-label={t('policyTitle')}>
  {!current?<p role="status" className="text-muted-foreground">{t('policyChecking')}</p>:!c?<p role="alert" className="text-muted-foreground">{t('policyUnavailable')}</p>:<>
   <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{t('policyTitle')}</span><span className="text-muted-foreground">{t(c.ready?'verifiedReady':'notReady')}</span><span className="rounded-md bg-muted px-2 py-1">{c.provider==='openwa'?t('policyNoWindow'):c.window_state==='open'&&!expired?t('policyWindowOpen',{time:format(remaining)}):t('policyWindowClosed')}</span></div>
   <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
    {!expired&&c.may_send_text&&<span>{t('policyText')}</span>}
    {!expired&&c.may_send_media&&<span>{t('policyMedia')}</span>}
    {c.may_send_template&&<span>{t('policyTemplate')}</span>}
    {!expired&&c.may_send_interactive&&<span>{t('policyInteractive')}</span>}
    {!expired&&c.may_react&&<span>{t('policyReaction')}</span>}
    {c.blocked_reason&&c.blocked_reason!=='meta_window_closed'&&<span>{t('policyDenied')} ({c.blocked_reason})</span>}
   </div>
   <p className="mt-1 text-[10px] text-muted-foreground">{t('policyPreviewOnly')}</p>
  </>}
 </section>
}
