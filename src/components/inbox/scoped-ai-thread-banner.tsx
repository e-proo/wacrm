'use client'
import {useEffect,useRef,useState} from 'react'
import {Hand,Sparkles,Undo2} from 'lucide-react'
import {useTranslations} from 'next-intl'
import {toast} from 'sonner'
import {Banner,BannerButton} from './ai-thread-banner'
import {fetchInbox,type InboxContext,type ScopedRow} from '@/lib/inbox/scoped-list-model'

type State={thread_id:string;channel_id:string;enabled:boolean;paused:boolean;human_assigned:boolean;handoff_summary:string|null;cap_reached:boolean;can_change:boolean;can_resume:boolean}
export function ScopedAiThreadBanner({row,ctx,revision,onRefresh}:{row:ScopedRow;ctx:InboxContext;revision:number;onRefresh:()=>void}){
 const t=useTranslations('Inbox.aiBanner'),s=useTranslations('Inbox.scoped')
 const [state,setState]=useState<State|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false),[refresh,setRefresh]=useState(0)
 const lock=useRef(false),mounted=useRef(false)
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 const path='threads/'+row.id+'/ai-control?channel_id='+row.channel_id
 useEffect(()=>{
  if(row.scope!=='active'||!row.channel_id)return
  const ctl=new AbortController()
  void fetchInbox<State>(path,ctx,ctl.signal,{retryTransient:true}).then(value=>{
   if(ctl.signal.aborted)return
   if(value.thread_id!==row.id||value.channel_id!==row.channel_id||typeof value.enabled!=='boolean'||typeof value.paused!=='boolean'||typeof value.human_assigned!=='boolean')throw Error('Invalid scope')
   setState(value);setError(false)
  }).catch(()=>{if(!ctl.signal.aborted){setState(null);setError(true)}})
  return()=>ctl.abort()
 },[path,row.id,row.channel_id,row.scope,ctx.accountId,ctx.userId,revision,refresh])
 async function toggle(paused:boolean){
  if(!state||!state.enabled||!state.can_change||!paused&&!state.can_resume||lock.current)return
  lock.current=true;setBusy(true)
  try{
   const res=await fetch('/api/inbox/'+path,{method:'POST',cache:'no-store',credentials:'same-origin',headers:{'content-type':'application/json','x-wacrm-inbox-account':ctx.accountId,'x-wacrm-inbox-actor':ctx.userId},body:JSON.stringify({paused,expectedPaused:state.paused,expectedHuman:state.human_assigned})})
   const body=await res.json().catch(()=>null)
   if(!res.ok||!body?.success||body.thread_id!==row.id||body.channel_id!==row.channel_id)throw Error('Control failed')
   if(mounted.current){setState(null);toast.success(paused?t('tookOver'):t('resumed'));onRefresh()}
  }catch{if(mounted.current){setState(null);toast.error(t('updateError'))}}
  finally{lock.current=false;if(mounted.current){setBusy(false);setRefresh(n=>n+1)}}
 }
 if(error)return <Banner tone="muted"><span className="min-w-0 flex-1 text-muted-foreground">{t('updateError')}</span><button type="button" className="text-primary underline" onClick={()=>setRefresh(n=>n+1)}>{s('retry')}</button></Banner>
 if(!state?.enabled)return null
 const human=state.paused||state.human_assigned
 return <Banner tone={human?'muted':'primary'}>
  <Sparkles className="size-4 shrink-0 text-primary"/>
  <div className="min-w-0 flex-1">
   <p className="font-medium text-foreground">{human?t('pausedTitle'):state.cap_reached?s('aiCapReached'):t('activeText')}</p>
   <p className="text-[11px] text-muted-foreground">{s('aiParentScope')}{human&&!state.can_resume?' · '+s('aiResumeRestricted'):''}</p>
   {human&&state.handoff_summary&&<p className="truncate text-muted-foreground" title={state.handoff_summary}>{state.handoff_summary}</p>}
  </div>
  {human?state.can_resume&&<BannerButton onClick={()=>void toggle(false)} busy={busy} icon={Undo2}>{t('resume')}</BannerButton>:state.can_change&&<BannerButton onClick={()=>void toggle(true)} busy={busy} icon={Hand}>{t('takeOver')}</BannerButton>}
 </Banner>
}
