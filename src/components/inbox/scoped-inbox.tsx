"use client"
import { useEffect,useRef,useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations,useLocale } from 'next-intl'
import { ArrowLeft, ChevronDown, CircleHelp, Filter, Inbox, RefreshCw, Search, ShieldCheck, Smartphone, X, Info, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import {useCan} from '@/hooks/use-can'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useInboxPages,useInboxCounts } from '@/lib/inbox/use-scoped-list'
import { useScopedInboxRealtime } from '@/lib/inbox/use-scoped-realtime'
import { ScopedHistoryPane } from './scoped-history-pane'
import {ScopedAiThreadBanner} from './scoped-ai-thread-banner'
import {ScopedActionPane,type ActiveActionScope} from './scoped-action-pane'
import {ScopedContactPanel} from './scoped-contact-panel'
import {ScopedNewThreadDialog} from './scoped-new-thread-dialog'
import { ScopedChannelReadiness } from './scoped-channel-readiness'
import { ScopedIntakeReview } from './scoped-intake-review'
import { ScopedOpenWAIntakeHealth } from './scoped-openwa-intake-health'
import {Sheet,SheetContent,SheetHeader,SheetTitle,SheetDescription} from '@/components/ui/sheet'
import {useBrowserOnline,scopedConnectivityNotice} from '@/lib/inbox/scoped-connectivity'
import {clearAccountScopedDrafts} from '@/lib/inbox/scoped-draft-memory'
import {clearAccountScopedAttachments} from '@/lib/inbox/scoped-attachment-memory'
import {submitScopedAction,inspectScopedAction,type ScopedActionOutcome} from '@/lib/inbox/scoped-action-client'
import type {HistoryMessage} from '@/lib/inbox/scoped-history-model'
import { defaultFilters, listQuery, parseLocation, preferenceKey, readPreference, sameScope, selectExact, selectionHref, type Channel,type Connection,type Counts,type InboxContext,type InboxFilters,type InboxScope,type InboxSelection,type ScopedRow } from '@/lib/inbox/scoped-list-model'

const control='h-9 min-w-0 rounded-lg border border-border bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring'
function go(href:string){window.history.replaceState(null,'',href)}
function useDebounced(value:string){
 const [resolved,setResolved]=useState(value)
 useEffect(()=>{const timer=setTimeout(()=>setResolved(value),250);return ()=>clearTimeout(timer)},[value])
 return resolved
}
function useLabels(){
 const t=useTranslations('Inbox.scoped')
 return {provider:(p:string|null)=>p==='meta_cloud'?'Meta Cloud':p==='openwa'?'OpenWA':t('unknown'),status:(s:string)=>s==='open'?t('open'):s==='pending'?t('pending'):s==='closed'?t('closed'):s==='ready'||s==='connected'?t('online'):s==='disconnected'||s==='logged_out'?t('offline'):t('unverified')}
}
function ErrorState({onRetry}:{onRetry:()=>void}){
 const t=useTranslations('Inbox.scoped')
 return <div role="alert" className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"><p>{t('error')}</p><Button variant="outline" onClick={onRetry}>{t('retry')}</Button></div>
}
function Wait(){const t=useTranslations('Inbox.scoped');return <div role="status" aria-live="polite" className="space-y-2 p-4 text-center text-sm text-muted-foreground"><div className="mx-auto h-3 w-3/4 animate-pulse rounded bg-muted motion-reduce:animate-none"/><div className="mx-auto h-3 w-1/2 animate-pulse rounded bg-muted motion-reduce:animate-none"/><span className="sr-only">{t('loading')}</span></div>}
function ProviderLabel({provider}:{provider:string|null}){
 const {provider:label}=useLabels()
 return <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium',provider==='meta_cloud'?'bg-blue-500/10 text-blue-700 dark:text-blue-300':provider==='openwa'?'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300':'bg-muted text-muted-foreground')}><span className="size-1.5 rounded-full bg-current"/>{label(provider)}</span>
}
function channelLabel(channel:Channel|undefined,t:(key:string)=>string){
 return channel?.display_name||channel?.own_phone||(channel?.provider==='meta_cloud'?'Meta Cloud':channel?.provider==='openwa'?'OpenWA':t('chooseChannel'))
}
export function ScopedThreadCard({row,selected,onSelect}:{row:ScopedRow;selected:boolean;onSelect:()=>void}){
 const t=useTranslations('Inbox.scoped'),locale=useLocale(),{status}=useLabels()
 const unread=row.scope==='unknown'?row.legacy_crm_unread??0:row.unread_count_known??0
 const time=row.last_message_at?new Date(row.last_message_at):null
 const prettyTime=time&&!Number.isNaN(time.getTime())?new Intl.DateTimeFormat(locale,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(time):''
 return <button type="button" onClick={onSelect} aria-pressed={selected} data-inbox-row-id={row.id} aria-label={(row.contact.name||row.contact.phone)+' · '+(row.channel_name||row.own_phone||'')}
  title={(row.contact.name||row.contact.phone)+' · '+(row.channel_name||row.own_phone||'')}
  className={cn('block min-h-11 w-full border-b border-border/60 px-3 py-3 text-start transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',selected?'bg-primary/8 border-s-2 border-s-primary':'border-s-2 border-s-transparent')}>
  <div className="flex items-start gap-3">
   <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-foreground">{(row.contact.name||row.contact.phone||'?').slice(0,2).toUpperCase()}</span>
   <div className="min-w-0 flex-1 space-y-1">
    <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold" dir="auto">{row.contact.name||row.contact.phone}</span><span className="shrink-0 text-[10px] text-muted-foreground">{prettyTime}</span></div>
    <div className="flex flex-wrap items-center gap-1.5"><ProviderLabel provider={row.provider}/><span className="min-w-0 max-w-40 truncate text-xs text-muted-foreground" dir="auto">{row.channel_name||row.own_phone||t(row.scope==='unknown'?'unverified':'verifiedChannel')}</span><span className="text-[10px] text-muted-foreground">{status(row.status)}</span></div>
    <div className="flex items-center gap-2"><span dir="auto" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{row.preview||t('noPreview')}</span>{unread>0&&<span aria-label={t(row.scope==='unknown'?'legacyUnread':'knownUnread')} className={cn('min-w-5 rounded-full px-1.5 py-0.5 text-center text-[11px] font-semibold',row.scope==='unknown'?'bg-muted text-muted-foreground':'bg-primary text-primary-foreground')}>{unread}</span>}</div>
    {row.assigned_agent_name&&<p className="truncate text-[10px] text-muted-foreground">{t('assigned')}: {row.assigned_to_me?t('mine'):row.assigned_agent_name}</p>}
   </div>
  </div>
 </button>
}
function ChannelSelector({ctx,loc,revision,onChange,onRetry}:{ctx:InboxContext;loc:InboxSelection;revision:number;onChange:(scope:InboxScope,channel:string|null)=>void;onRetry:()=>void}){
 const t=useTranslations('Inbox.scoped')
 const scope=loc.scope==='unknown'?'active':loc.scope
 const catalog=useInboxPages<Channel>('channels?scope='+scope+'&limit=30',ctx,c=>c.scope===scope,revision)
 const exact=useInboxPages<Channel>('channels?scope=all&limit=1'+(loc.channel?'&channel_id='+loc.channel:''),ctx,undefined,revision)
 const selected=loc.channel?catalog.items.find(c=>c.id===loc.channel)||exact.items.find(c=>c.id===loc.channel):undefined
 const [expanded,setExpanded]=useState(false)
 const ready=selected?.scope===scope
 return <div className="space-y-2 border-b border-border p-3">
  <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1" role="group" aria-label={t('scope')}>
   {(['active','historical','unknown'] as const).map(s=><button key={s} type="button" aria-pressed={loc.scope===s} onClick={()=>onChange(s,null)} className={cn('min-h-11 rounded-md px-1 py-2 text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring',loc.scope===s?'bg-background text-foreground shadow-sm':'text-muted-foreground hover:text-foreground')}>{t(s)}</button>)}
  </div>
  {loc.scope!=='unknown'&&<>
   <label className="block space-y-1 text-xs font-medium"><span>{t('channel')}</span>
    <select className={cn(control,'w-full')} value={loc.channel??''} onChange={e=>onChange(loc.scope,e.target.value||null)}>
     <option value="">{t(loc.scope==='active'?'allActive':'allHistorical')}</option>
     {loc.channel&&!catalog.items.some(c=>c.id===loc.channel)&&<option value={loc.channel}>{selected?channelLabel(selected,t):t('checkingChannel')}</option>}
     {catalog.items.map(c=><option key={c.id} value={c.id}>{channelLabel(c,t)} · {c.provider==='meta_cloud'?'Meta Cloud':'OpenWA'}{c.own_phone&&c.display_name?' · '+c.own_phone:''}</option>)}
    </select>
   </label>
   {catalog.error&&<ErrorState onRetry={onRetry}/>}
   {catalog.cursor&&<Button variant="ghost" size="sm" disabled={catalog.busy} onClick={catalog.more}>{t('moreChannels')}</Button>}
   {loc.channel&&selected&&!ready&&<div className="rounded-lg bg-muted p-2 text-xs"><p>{t('channelMoved')}</p><Button variant="outline" className="mt-1" onClick={()=>onChange(selected.scope,selected.id)}>{t(selected.scope)}</Button></div>}
   {loc.channel&&!selected&&!exact.busy&&<p className="text-xs text-destructive">{t('notFound')}</p>}
  {loc.scope==='active'&&!catalog.busy&&!catalog.error&&!catalog.items.length&&<p role="status" className="text-xs text-muted-foreground">{t('actionNoActiveChannels')}</p>}
   {selected&&ready&&<div className="flex flex-wrap items-center gap-2 text-xs"><ProviderLabel provider={selected.provider}/><span className="text-muted-foreground">{t('sessionsReady')}: {selected.ready_sessions}</span><span className="text-muted-foreground">{t(selected.ready?'online':'offline')}</span></div>}
  </>}
  <Button variant="ghost" className="w-full justify-between" onClick={()=>setExpanded(v=>!v)} aria-expanded={expanded}><span className="flex items-center gap-2"><Smartphone className="size-4"/>{t('sessions')}</span><ChevronDown className={cn('size-4 transition-transform',expanded&&'rotate-180')}/></Button>
  {expanded&&<SessionList key={loc.scope+':'+loc.channel} ctx={ctx} loc={loc} revision={revision} onRetry={onRetry}/>}
  <ScopedChannelReadiness ctx={ctx} onChanged={onRetry}/>
  <ScopedIntakeReview ctx={ctx} onChanged={onRetry}/>
  <ScopedOpenWAIntakeHealth ctx={ctx} onChanged={onRetry}/>
 </div>
}
function SessionList({ctx,loc,revision,onRetry}:{ctx:InboxContext;loc:InboxSelection;revision:number;onRetry:()=>void}){
 const t=useTranslations('Inbox.scoped'),{status}=useLabels()
 const q=new URLSearchParams({scope:loc.channel?'all':loc.scope,limit:'20'})
 if(loc.channel)q.set('channel_id',loc.channel)
 const data=useInboxPages<Connection>('connections?'+q.toString(),ctx,c=>!loc.channel||c.channel_id===loc.channel,revision)
 return <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border bg-muted/30 p-2">
  <p className="text-[11px] text-muted-foreground">{t('diagnosticsOnly')}</p>
  {data.items.map(c=><div key={c.id} className="rounded-md bg-background p-2 text-xs"><div className="flex items-center justify-between gap-1"><span dir="auto" className="min-w-0 truncate font-medium">{c.display_name||t('unnamedSession')}</span><ProviderLabel provider={c.provider}/></div><div className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground"><span>{c.archived?t('historical'):status(c.status)}</span><span>{t(c.ready?'verifiedReady':c.identity_state==='unverified'?'unverified':'notReady')}</span>{c.is_primary&&<span>{t('primary')}</span>}</div></div>)}
  {data.busy&&<Wait/>}{!data.busy&&!data.error&&!data.items.length&&<p className="p-1 text-xs text-muted-foreground">{t('emptySessions')}</p>}
  {data.error&&<ErrorState onRetry={onRetry}/>}
  {data.cursor&&<Button size="sm" variant="ghost" disabled={data.busy} onClick={data.more}>{t('more')}</Button>}
 </div>
}
function Filters({value,onChange}:{value:InboxFilters;onChange:(v:InboxFilters)=>void}){
 const t=useTranslations('Inbox.scoped'),[open,setOpen]=useState(false)
 return <div className="space-y-2 border-b border-border p-3">
  <label className="relative block"><Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-muted-foreground"/><input className={cn(control,'w-full ps-9')} aria-label={t('search')} placeholder={t('search')} maxLength={120} value={value.search} onChange={e=>onChange({...value,search:e.target.value})}/></label>
  <div className="flex items-center gap-2">
   <select className={cn(control,'flex-1')} aria-label={t('status')} value={value.status} onChange={e=>onChange({...value,status:e.target.value as InboxFilters['status']})}>{(['all','open','pending','closed'] as const).map(s=><option key={s} value={s}>{t(s)}</option>)}</select>
   <Button variant={value.unread?'secondary':'outline'} aria-pressed={value.unread} onClick={()=>onChange({...value,unread:!value.unread})}>{t('unread')}</Button>
   <Button variant="outline" size="icon-lg" aria-label={t('filters')} aria-expanded={open} onClick={()=>setOpen(v=>!v)}><Filter className="size-4"/></Button>
  </div>
  {open&&<div className="space-y-2 rounded-lg bg-muted/40 p-2">
   <label className="block space-y-1 text-xs"><span>{t('assigned')}</span><select className={cn(control,'w-full')} value={value.assignment} onChange={e=>onChange({...value,assignment:e.target.value as InboxFilters['assignment']})}>{(['all','mine','unassigned'] as const).map(s=><option key={s} value={s}>{t(s)}</option>)}</select></label>
   <label className="block space-y-1 text-xs"><span>{t('company')}</span><input className={cn(control,'w-full')} placeholder={t('company')} maxLength={160} value={value.company} onChange={e=>onChange({...value,company:e.target.value})}/></label>
   <Button variant="ghost" size="sm" onClick={()=>onChange({...defaultFilters})}><X className="size-4"/>{t('clearFilters')}</Button>
  </div>}
 </div>
}
function TagPicker({ctx,revision,selected,onChange,onRetry}:{ctx:InboxContext;revision:number;selected:string[];onChange:(v:string[])=>void;onRetry:()=>void}){
 const t=useTranslations('Inbox.scoped'),[open,setOpen]=useState(false)
 const tags=useInboxPages<{id:string;name:string}>('filter-tags?scope=all&limit=30',ctx,undefined,revision)
 return <div className="border-b border-border px-3 py-1"><Button variant="ghost" size="sm" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>{t('tags')}{selected.length>0?' ('+selected.length+')':''}<ChevronDown className="size-3"/></Button>
 {open&&<div className="max-h-36 space-y-1 overflow-auto py-1">{tags.items.map(tag=><label key={tag.id} className="flex items-center gap-2 rounded-md p-1 text-xs hover:bg-muted"><input type="checkbox" checked={selected.includes(tag.id)} disabled={selected.length>=20&&!selected.includes(tag.id)} onChange={()=>onChange(selected.includes(tag.id)?selected.filter(x=>x!==tag.id):[...selected,tag.id])}/><span className="truncate" dir="auto">{tag.name}</span></label>)}{tags.busy&&<Wait/>}{tags.error&&<ErrorState onRetry={onRetry}/>} {tags.cursor&&<Button size="sm" variant="ghost" onClick={tags.more} disabled={tags.busy}>{t('more')}</Button>}</div>}</div>
}
function ScopeList({ctx,loc,filters,revision,onSelect,onRetry}:{ctx:InboxContext;loc:InboxSelection;revision:number;filters:InboxFilters;onSelect:(row:ScopedRow)=>void;onRetry:()=>void}){
 const t=useTranslations('Inbox.scoped'),query=listQuery(loc.scope,loc.channel,filters)
 const list=useInboxPages<ScopedRow>('threads?'+query,ctx,r=>sameScope(r,loc.scope,loc.channel),revision)
 const counts=useInboxCounts<Counts>('counts?'+query,ctx,revision)
 return <div className="flex min-h-0 flex-1 flex-col">
  <div className="grid grid-cols-3 gap-1 border-b border-border px-3 py-2 text-center">
   {[[t('threads'),counts.value?.threads],[t('messages'),counts.value?.lane_messages],[t(loc.scope==='unknown'?'legacyUnread':'knownUnread'),loc.scope==='unknown'?counts.value?.legacy_lane_unread:counts.value?.known_unread]].map(([label,n])=><div key={label} className="rounded-md bg-muted/40 px-1 py-1.5"><div className="text-sm font-semibold tabular-nums">{n===undefined?'—':n}</div><div className="text-[10px] text-muted-foreground">{label}</div></div>)}
  </div>
  {counts.error&&<div className="p-2"><ErrorState onRetry={onRetry}/></div>}
  {loc.scope==='unknown'&&<p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">{t('unknownExplanation')}</p>}
  <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={list.busy}>
   {list.items.map(r=><ScopedThreadCard key={r.scope+':'+r.id} row={r} selected={!loc.legacy&&(loc.scope==='unknown'?loc.parent===r.id:loc.thread===r.id)} onSelect={()=>onSelect(r)}/>)}
   {list.busy&&<Wait/>}
   {list.error&&<div className="p-3"><ErrorState onRetry={onRetry}/></div>}
   {!list.busy&&!list.error&&!list.items.length&&<div className="flex flex-col items-center gap-2 p-8 text-center text-xs text-muted-foreground"><Inbox className="size-8 opacity-50"/><p className="text-sm font-medium">{t('empty')}</p><p>{t(loc.scope==='active'?'emptyActive':'emptyFiltered')}</p></div>}
   {list.cursor&&<div className="p-3"><Button variant="outline" className="w-full" disabled={list.busy} onClick={list.more}>{t('more')}</Button></div>}
  </div>
 </div>
}
function DetailCard({row,ctx,revision,onBack,onRefresh}:{row:ScopedRow;ctx:InboxContext;revision:number;onBack:()=>void;onRefresh:()=>void}){
 const t=useTranslations('Inbox.scoped'),locale=useLocale(),online=useBrowserOnline(),{status}=useLabels()
 const titleRef=useRef<HTMLHeadingElement>(null)
 useEffect(()=>{titleRef.current?.focus()},[row.id])
 const [selectedConnection,setSelectedConnection]=useState<string|null>(null)
 const [activeAction,setActiveAction]=useState<ActiveActionScope|null>(null)
 const [reply,setReply]=useState<HistoryMessage|null>(null)
 const canPrepareReply=useCan('send-messages')&&row.scope==='active'
 const [nativeBusy,setNativeBusy]=useState(false)
 const [contactOpen,setContactOpen]=useState(false)
 const [desktopContactOpen,setDesktopContactOpen]=useState(false)
 const [nativeOutcome,setNativeOutcome]=useState<ScopedActionOutcome|null>(null)
 const locks=useRef(new Map<string,{key:string;state:ScopedActionOutcome['state']}>())
 async function nativeAction(kind:'provider_read'|'reaction',message:HistoryMessage,emoji=''){
  if(nativeBusy||!online||!activeAction||selectedConnection!==activeAction.scope.connectionId||row.scope!=='active'||message.channel_id!==row.channel_id||message.conversation_id!==row.conversation_id||message.provider!==row.provider)return
  const {scope,capabilities}=activeAction
  if(!capabilities.dispatch_enabled||(kind==='provider_read'?!capabilities.may_read:!capabilities.may_react))return
  const identity=[scope.connectionId,scope.membershipId,message.id,kind,emoji].join(':')
  const old=locks.current.get(identity)
  setNativeBusy(true)
  let nextKey=old?.key
  try{
   // Only a proven pre-dispatch blocked result may receive a new key
   // on a second deliberate click. An uncertain result is status-only.
   let current:ScopedActionOutcome
   if(old&&old.state!=='blocked'){
    current=await inspectScopedAction(ctx,row.id,old.key)
   }else{
    nextKey=crypto.randomUUID()
    locks.current.set(identity,{key:nextKey,state:'pending'})
    current=await submitScopedAction(ctx,kind==='provider_read'
      ?{scope,key:nextKey,action:'provider_read',messageId:message.id}
      :{scope,key:nextKey,action:'reaction',messageId:message.id,emoji})
   }
   if(nextKey)locks.current.set(identity,{key:nextKey,state:current.state})
   setNativeOutcome(current)
   if(current.state==='accepted')onRefresh()
  }catch{
   if(nextKey)locks.current.set(identity,{key:nextKey,state:'uncertain'})
   setNativeOutcome({state:'uncertain',code:'admission_unconfirmed'})
  }finally{setNativeBusy(false)}
 }
 return <div className="relative flex h-full min-h-0 min-w-0">
  <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
  <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-3 py-3 sm:px-4">
   <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
    <Button variant="ghost" size="icon-lg" className="min-h-11 min-w-11 lg:hidden" onClick={onBack} aria-label={t('back')}><ArrowLeft className="size-4 rtl:rotate-180"/></Button>
    <div aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">{(row.contact.name||row.contact.phone).slice(0,1).toUpperCase()}</div>
    <div className="min-w-0 text-start">
     <h2 ref={titleRef} tabIndex={-1} className="truncate rounded-sm text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"><bdi>{row.contact.name||row.contact.phone}</bdi></h2>
     {row.contact.name&&row.contact.name!==row.contact.phone&&<p className="truncate text-xs text-muted-foreground"><bdi dir="ltr">{row.contact.phone}</bdi></p>}
     <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"><ProviderLabel provider={row.provider}/><span className="truncate"><bdi>{row.channel_name||row.own_phone||t(row.scope==='unknown'?'unverified':'verifiedChannel')}</bdi></span></div>
    </div>
   </div>
   <div className="flex shrink-0 items-center gap-1 sm:gap-2">
    <span className="hidden max-w-24 truncate rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground sm:inline" title={status(row.status)}>{status(row.status)}</span>
    {row.assigned_agent_name&&<span className="hidden max-w-28 truncate text-xs text-muted-foreground xl:inline" title={row.assigned_agent_name}><bdi>{row.assigned_agent_name}</bdi></span>}
    <Button type="button" variant="ghost" size="sm" className="h-9 w-9 p-0 text-muted-foreground" onClick={onRefresh} aria-label={t('refresh')} title={t('refresh')}><RefreshCw className="size-4"/></Button>
    <Button type="button" variant="ghost" size="sm" className="hidden h-9 w-9 p-0 lg:inline-flex" onClick={()=>setDesktopContactOpen(v=>!v)} aria-pressed={desktopContactOpen} aria-label={t('actionContactDetails')} title={t('actionContactDetails')}>{desktopContactOpen?<PanelRightClose className="size-4 rtl:rotate-180"/>:<PanelRightOpen className="size-4 rtl:rotate-180"/>}</Button>
    <Button type="button" variant="ghost" size="sm" className="h-9 w-9 p-0 lg:hidden" onClick={()=>setContactOpen(true)} aria-expanded={contactOpen} aria-label={t('actionContactDetails')}><Info className="size-4"/></Button>
   </div>
  </div>
  {nativeOutcome&&<div role="status" className="border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">{t('actionProviderResult')}: {t('actionState_'+nativeOutcome.state)}{nativeOutcome.code?' · '+nativeOutcome.code:''}</div>}
  <ScopedHistoryPane key={row.scope+':'+row.id+':'+row.channel_id} row={row} ctx={ctx} revision={revision} onRefresh={onRefresh}
   actions={row.scope==='active'?{
    // Preparing a quote is local only. Dispatch still requires server policy,
    // a selected connection and native-target proof at reservation.
    canReply:canPrepareReply,canRead:Boolean(online&&activeAction?.capabilities.dispatch_enabled&&activeAction.capabilities.may_read),canReact:Boolean(online&&activeAction?.capabilities.dispatch_enabled&&activeAction.capabilities.may_react),
    onReply:setReply,onNative:(kind,message,emoji)=>{void nativeAction(kind,message,emoji)},busy:nativeBusy
   }:undefined}/>
  {row.scope==='active'&&<ScopedAiThreadBanner key={row.id+':'+row.channel_id} row={row} ctx={ctx} revision={revision} onRefresh={onRefresh}/>}
  {row.scope==='active'&&<ScopedActionPane row={row} ctx={ctx} revision={revision} selectedConnection={selectedConnection} onSelectConnection={value=>{if(selectedConnection&&value!==selectedConnection)setReply(null);setSelectedConnection(value)}}
   reply={reply} onClearReply={()=>setReply(null)} onScopeChange={setActiveAction} onRefresh={onRefresh}/>}
  </div>
  {desktopContactOpen&&<aside aria-label={t('actionContactDetails')} className="hidden min-h-0 w-72 shrink-0 overflow-y-auto border-s border-border bg-card lg:block xl:w-80"><ScopedContactPanel row={row} ctx={ctx}/></aside>}
  <Sheet open={contactOpen} onOpenChange={setContactOpen}>
   <SheetContent side={locale==='ar'?'left':'right'} showCloseButton={false} className="h-[100dvh] w-[min(92vw,22rem)] gap-0 overflow-hidden p-0 sm:max-w-[22rem]">
    <SheetHeader className="flex-row items-center justify-between gap-2 border-b border-border px-3 py-2">
     <SheetTitle>{t('actionContactDetails')}</SheetTitle>
     <SheetDescription className="sr-only">{t('actionNoCrossAccount')}</SheetDescription>
     <Button size="icon-lg" variant="ghost" onClick={()=>setContactOpen(false)} aria-label={t('actionCloseContact')}><X className="size-4"/></Button>
    </SheetHeader>
    <div className="min-h-0 flex-1 overflow-y-auto"><ScopedContactPanel row={row} ctx={ctx}/></div>
   </SheetContent>
  </Sheet>
 </div>
}
function SelectedDetail({ctx,loc,revision,onBack,onRetry}:{ctx:InboxContext;loc:InboxSelection;revision:number;onBack:()=>void;onRetry:()=>void}){
 const t=useTranslations('Inbox.scoped')
 const id=loc.scope==='unknown'?loc.parent:loc.thread
 const result=useInboxPages<ScopedRow>('threads?'+listQuery(loc.scope,loc.channel,defaultFilters,id??undefined),ctx,r=>sameScope(r,loc.scope,loc.channel),revision)
 const row=selectExact(result.items,loc)
 if(result.busy)return <Wait/>
 if(result.error)return <div className="p-4"><ErrorState onRetry={onRetry}/><Button className="mt-2" variant="ghost" onClick={onBack}>{t('back')}</Button></div>
 if(!row)return <div className="space-y-3 p-4"><p className="text-sm text-muted-foreground">{t('notFound')}</p><Button variant="outline" onClick={onBack}>{t('back')}</Button></div>
 return <DetailCard row={row} ctx={ctx} revision={revision} onBack={onBack} onRefresh={onRetry}/>
}
function LegacyChoices({ctx,loc,onSelect,onBack,onRetry}:{ctx:InboxContext;loc:InboxSelection;onSelect:(r:ScopedRow)=>void;onBack:()=>void;onRetry:()=>void}){
 const t=useTranslations('Inbox.scoped'),q=new URLSearchParams({scope:'all',limit:'30'})
 if(loc.connection)q.set('connection_id',loc.connection)
 const data=useInboxPages<ScopedRow>('resolve/'+loc.parent+'?'+q.toString(),ctx,r=>r.conversation_id===loc.parent)
 const candidates=data.items.filter(r=>(!loc.channel||r.channel_id===loc.channel)&&(!loc.thread||r.id===loc.thread))
 useEffect(()=>{if(!data.busy&&!data.error&&!data.cursor&&candidates.length===1)onSelect(candidates[0])},[data.busy,data.error,data.cursor,candidates,onSelect])
 return <div className="space-y-3 p-4"><Button variant="ghost" onClick={onBack}><ArrowLeft className="size-4 rtl:rotate-180"/>{t('back')}</Button><h2 className="font-semibold">{t('chooseThread')}</h2><p className="text-sm text-muted-foreground">{t('ambiguous')}</p><div className="overflow-hidden rounded-xl border border-border">{candidates.map(r=><ScopedThreadCard key={r.scope+':'+r.id} row={r} selected={false} onSelect={()=>onSelect(r)}/>)}</div>{data.busy&&<Wait/>}{data.error&&<ErrorState onRetry={onRetry}/>} {!data.busy&&!data.error&&!candidates.length&&!data.cursor&&<p className="text-sm text-muted-foreground">{t('notFound')}</p>}{data.cursor&&<Button variant="outline" disabled={data.busy} onClick={data.more}>{t('more')}</Button>}</div>
}
function Workspace({ctx}:{ctx:InboxContext}){
 const t=useTranslations('Inbox.scoped'),params=useSearchParams(),query=params.toString(),loc=parseLocation(query)
 const canSend=useCan('send-messages')
 const [filters,setFilters]=useState<InboxFilters>({...defaultFilters}),[revision,setRevision]=useState(0)
 const [newThreadOpen,setNewThreadOpen]=useState(false)
 const latestSelected=useRef<string|null>(null)
 const restoringFocus=useRef(false)
 const online=useBrowserOnline()
 useEffect(()=>()=>{clearAccountScopedDrafts({accountId:ctx.accountId,userId:ctx.userId});clearAccountScopedAttachments({accountId:ctx.accountId,userId:ctx.userId})},[ctx.accountId,ctx.userId])
 const search=useDebounced(filters.search),company=useDebounced(filters.company)
 const effective={...filters,search,company}
 useEffect(()=>{
  if(query)return
  try{const prefs=readPreference(localStorage.getItem(preferenceKey(ctx)));if(prefs)go(selectionHref(prefs.scope,prefs.channel))}catch{/* Storage is optional. */}
 },[query,ctx])
 const changeScope=(scope:InboxScope,channel:string|null)=>{
  go(selectionHref(scope,channel))
  try{localStorage.setItem(preferenceKey(ctx),JSON.stringify({scope,channel}))}catch{/* Storage is optional. */}
 }
 const close=()=>{
  restoringFocus.current=true
  go(selectionHref(loc.scope,loc.channel))
 }
 const choose=(row:ScopedRow)=>{latestSelected.current=row.id;go(selectionHref(row.scope,loc.legacy||loc.scope!==row.scope?row.channel_id:loc.channel,row))}
 const changeFilters=(next:InboxFilters)=>{setFilters(next);close()}
 const refresh=()=>setRevision(x=>x+1)
 const realtime=useScopedInboxRealtime(ctx,refresh)
 const connectivityNotice=scopedConnectivityNotice(online,realtime)
 const hasSelection=!loc.invalid&&Boolean(loc.legacy||loc.thread||(loc.scope==='unknown'&&loc.parent))
 useEffect(()=>{
  if(hasSelection||!restoringFocus.current)return
  const handle=requestAnimationFrame(()=>{
   restoringFocus.current=false
   const id=latestSelected.current
   const rows=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-inbox-row-id]'))
   const target=rows.find(el=>el.dataset.inboxRowId===id&&el.getClientRects().length>0)
   target?.focus({preventScroll:true})
  })
  return()=>cancelAnimationFrame(handle)
 },[hasSelection,loc.scope,loc.channel])
 const listKey=[loc.scope,loc.channel,JSON.stringify(effective)].join(':')
 return <div className="-m-4 flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background sm:-m-6">
  <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-3">
   <div className="flex min-w-0 items-center gap-3"><div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><Inbox className="size-5"/></div><div><h1 className="text-base font-semibold">{t('title')}</h1><p className="text-[11px] text-muted-foreground">{t('subtitle')}</p></div></div>
   <div className="flex items-center gap-2">{canSend&&<Button size="sm" variant="outline" onClick={()=>setNewThreadOpen(true)}>{t('actionNewThread')}</Button>}<span className="hidden items-center gap-1.5 rounded-full border border-border px-2 py-1 text-xs text-muted-foreground sm:inline-flex"><ShieldCheck className="size-3.5"/>{t('actionTestProtected')}</span><Button variant="outline" size="icon-lg" onClick={refresh} aria-label={t('refresh')}><RefreshCw className="size-4"/></Button></div>
  </header>
  {connectivityNotice&&<div role="status" aria-live="polite" className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/70 px-3 py-2 text-xs text-muted-foreground"><span>{t(connectivityNotice==='browser_offline'?'actionBrowserOffline':'actionRealtimeReconnecting')}</span><Button size="sm" variant="outline" className="min-h-11" onClick={refresh}>{t('refresh')}</Button></div>}
  {loc.invalid?<div className="space-y-2 p-4"><p role="alert" className="text-sm text-destructive">{t('invalidLink')}</p><Button variant="outline" onClick={()=>changeScope('active',null)}>{t('back')}</Button></div>:<div className="flex min-h-0 flex-1">
   <aside aria-label={t('actionThreadList')} className={cn('min-h-0 w-full flex-col border-e border-border bg-card lg:w-[380px] lg:shrink-0',hasSelection?'hidden lg:flex':'flex')}>
    <div className="max-h-[55%] shrink-0 overflow-y-auto">
     <ChannelSelector key={[loc.scope,loc.channel].join(':')} ctx={ctx} loc={loc} revision={revision} onChange={changeScope} onRetry={refresh}/>
     <Filters value={filters} onChange={changeFilters}/>
     <TagPicker revision={revision} ctx={ctx} selected={filters.tags} onChange={tags=>changeFilters({...filters,tags})} onRetry={refresh}/>
    </div>
    {search!==filters.search||company!==filters.company?<Wait/>:<ScopeList key={listKey} revision={revision} ctx={ctx} loc={loc} filters={effective} onSelect={choose} onRetry={refresh}/>}
   </aside>
   <main id="scoped-inbox-main" className={cn('min-h-0 min-w-0 flex-1 overflow-hidden',hasSelection?'block':'hidden lg:block')}>
    {hasSelection?(loc.legacy?<LegacyChoices key={query+':'+revision} ctx={ctx} loc={loc} onSelect={choose} onBack={close} onRetry={refresh}/>:<SelectedDetail key={query} revision={revision} ctx={ctx} loc={loc} onBack={close} onRetry={refresh}/>):
     <div className="flex h-full flex-col items-center justify-center gap-3 bg-background bg-[url('/inbox-doodle.svg')] bg-repeat p-6 text-center"><div className="rounded-full bg-muted p-5 text-muted-foreground"><CircleHelp className="size-8"/></div><h2 className="font-medium">{t('selectThread')}</h2><p className="max-w-sm text-sm text-muted-foreground">{t('selectHelp')}</p></div>}
   </main>
  </div>}
  <ScopedNewThreadDialog open={newThreadOpen} onOpenChange={setNewThreadOpen} ctx={ctx} onCreated={href=>{go(href);refresh()}}/>
 </div>
}
export function ScopedInbox(){
 const t=useTranslations('Inbox.scoped'),{accountId,user,accountStatus}=useAuth()
 if(accountStatus==='loading')return <Wait/>
 if(accountStatus!=='ready'||!accountId||!user)return <p role="alert" className="p-4 text-sm text-muted-foreground">{t('error')}</p>
 return <Workspace key={accountId+':'+user.id} ctx={{accountId,userId:user.id}}/>
}
