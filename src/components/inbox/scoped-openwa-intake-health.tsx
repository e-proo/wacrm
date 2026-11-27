'use client'
import {useState} from 'react'
import {useLocale,useTranslations} from 'next-intl'
import {Activity,RefreshCw} from 'lucide-react'
import {useCan} from '@/hooks/use-can'
import {Button} from '@/components/ui/button'
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle,DialogTrigger} from '@/components/ui/dialog'
import type {InboxContext} from '@/lib/inbox/scoped-list-model'
import {useAdminSnapshot} from '@/lib/inbox/use-admin-snapshot'
import {normalizeIntakeHealthPage,type IntakeReviewRow} from '@/lib/inbox/openwa-intake-health-model'
const reasons={binding_changed:'intakeBindingChanged',processing_uncertain:'intakeProcessingUncertain',lease_expired:'intakeLeaseExpired',payload_unavailable:'intakePayloadUnavailable',legacy_payload_missing:'intakeLegacyPayloadMissing'} as const
function ReviewCase({row,ctx,allowed,onClosed}:{row:IntakeReviewRow;ctx:InboxContext;allowed:boolean;onClosed:()=>void}){
 const t=useTranslations('Inbox.scoped'),locale=useLocale()
 const [confirm,setConfirm]=useState(false),[checked,setChecked]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null)
 const fmt=(at:string)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(new Date(at))
 async function close(){
  if(!allowed||!checked||busy||row.state!=='review'||!row.can_close)return
  setBusy(true);setError(null)
  try{
   const response=await fetch('/api/inbox/openwa-intake-health',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/json','x-wacrm-inbox-account':ctx.accountId,'x-wacrm-inbox-actor':ctx.userId},body:JSON.stringify({receiptId:row.id,confirmMaintenance:true})})
   const result:unknown=await response.json().catch(()=>null)
   if(!response.ok||!result||typeof result!=='object'||!('state' in result)||result.state!=='closed_unverified'){
    setError(response.status===409?'reviewConflict':'reviewFailed');return
   }
   setConfirm(false);setChecked(false);onClosed()
  }catch{setError('reviewFailed')}finally{setBusy(false)}
 }
 return <article className="space-y-2 rounded-lg border p-3">
  <div className="flex flex-wrap items-start justify-between gap-2"><div><h4 className="font-medium break-words" dir="auto">{row.display_name||t('unnamedSession')}</h4><p dir="ltr" className="text-xs text-muted-foreground">OpenWA · {row.id.slice(0,8)} · {row.canonical?'Canonical':'Legacy'}</p></div><span className="rounded-full border px-2 py-1 text-xs">{t(row.state==='review'?'intakeReview':'reviewClosedUnverified')}</span></div>
  <p className="text-sm">{t(reasons[row.reason])}</p><p className="text-xs text-muted-foreground">{fmt(row.received_at)}{row.finished_at&&<> · {t('reviewResolvedAt')}: {fmt(row.finished_at)}</>}</p>
  {row.closed_at&&<p className="text-xs text-muted-foreground">{t('intakeClosedAt')}: {fmt(row.closed_at)}</p>}
  {row.state==='review'&&row.can_close&&allowed&&!confirm&&<Button type="button" className="min-h-11" variant="outline" onClick={()=>setConfirm(true)}>{t('reviewCloseUnverified')}</Button>}
  {row.state==='review'&&row.can_close&&allowed&&confirm&&<div className="rounded-md border bg-muted/30 p-3 space-y-2"><p className="text-xs">{t('intakeCloseNotice')}</p><label className="flex gap-2 min-h-11 text-xs"><input type="checkbox" className="size-4 shrink-0" checked={checked} disabled={busy} onChange={e=>setChecked(e.target.checked)}/>{t('intakeMaintenanceConfirm')}</label><div className="flex gap-2 flex-wrap"><Button type="button" className="min-h-11" disabled={!checked||busy} onClick={()=>void close()}>{busy?t('loading'):t('reviewConfirm')}</Button><Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={()=>{setConfirm(false);setChecked(false);setError(null)}}>{t('actionCancelReply')}</Button></div>{error&&<p role="alert" className="text-xs text-destructive">{t(error)}</p>}</div>}
 </article>
}
export function ScopedOpenWAIntakeHealth({ctx,onChanged}:{ctx:InboxContext;onChanged:()=>void}){
 const t=useTranslations('Inbox.scoped'),locale=useLocale(),authorized=useCan('edit-settings')
 const [open,setOpen]=useState(false),[rev,setRev]=useState(0),[trail,setTrail]=useState<(string|null)[]>([null]),[notice,setNotice]=useState(false)
 const after=trail.at(-1)??null
 const {page,refreshing,error}=useAdminSnapshot(ctx,open&&authorized,'openwa-intake-health'+(after?'?after='+encodeURIComponent(after):''),rev,normalizeIntakeHealthPage)
 if(!authorized)return null
 const h=page?.health
 const n=new Intl.NumberFormat(locale),fmt=(v:number)=>n.format(v),mib=(v:number)=>new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(v/1048576)+' MiB'
 function changed(){setNotice(true);setRev(x=>x+1);setTrail([null]);onChanged()}
 return <Dialog open={open} onOpenChange={v=>{setOpen(v);if(v){setTrail([null]);setRev(x=>x+1);setNotice(false)}}}>
  <DialogTrigger render={<Button type="button" variant="outline" className="w-full min-h-11 justify-start gap-2"/>}><Activity className="size-4 shrink-0"/>{t('intakeTitle')}</DialogTrigger>
  <DialogContent className="max-h-[min(90dvh,54rem)] overflow-y-auto overscroll-contain pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-w-3xl">
   <DialogHeader className="pe-8"><DialogTitle>{t('intakeTitle')} · TEST</DialogTitle><DialogDescription>{t('intakeDescription')}</DialogDescription></DialogHeader>
   <div className="flex justify-between items-center gap-2"><p className="text-xs text-muted-foreground">{t('intakeSnapshotNotice')}</p><Button type="button" variant="outline" className="min-h-11 gap-1.5 shrink-0" disabled={refreshing} aria-busy={refreshing} onClick={()=>setRev(x=>x+1)}><RefreshCw aria-hidden="true" className={refreshing?'size-4 animate-spin motion-reduce:animate-none':'size-4'}/>{t('readinessRefresh')}</Button></div>
   {notice&&<p role="status" className="rounded-md bg-muted p-2 text-sm">{t('reviewClosedUnverified')}</p>}
   {refreshing&&!page&&<p role="status" className="p-4 text-center text-sm">{t('loading')}</p>}
   {error&&<div role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm">{t('intakeLoadFailed')} <Button type="button" className="mt-2 min-h-11" variant="outline" onClick={()=>setRev(x=>x+1)}>{t('retry')}</Button></div>}
   {page&&h&&<fieldset disabled={refreshing} aria-busy={refreshing} className="min-w-0 space-y-3 border-0 p-0">
    <div className="flex flex-wrap gap-2 text-xs"><span className="rounded-md border px-2 py-1">{t(page.enabled?'intakeEnabled':'intakeDisabled')}</span><span className="rounded-md border px-2 py-1">{page.canonical?'Canonical':'Legacy'}</span></div>
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">{([['intakePending',h.pending],['intakeRunning',h.running],['intakeReview',h.review],['intakeCompleted24h',h.completed_24h]] as const).map(([label,value])=><div key={label} className="rounded-lg border bg-muted/30 p-3"><p className="text-xs text-muted-foreground">{t(label)}</p><p className="mt-1 text-xl font-semibold tabular-nums">{fmt(value)}</p></div>)}</div>
    <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 rounded-lg border p-3 text-xs">
     {([['intakeOldestPending',fmt(h.oldest_pending_seconds)+' s'],['intakeOldestRunning',fmt(h.oldest_running_seconds)+' s'],['intakeModeBlocked',fmt(h.mode_blocked)],['intakeReviewBlocked',fmt(h.review_blocked)],['intakeLegacyUnfinished',fmt(h.legacy_unfinished)],['intakeLegacyClosed',fmt(h.legacy_closed)],['intakeRetained',fmt(h.retained_events)+' / 500'],['intakeCapacity',mib(h.retained_bytes)+' / 128 MiB'],['intakeClosedCount',fmt(h.closed_unverified)]] as const).map(([label,value])=><div key={label}><dt className="text-muted-foreground">{t(label)}</dt><dd className="mt-1 font-medium tabular-nums" dir="ltr">{value}</dd></div>)}
    </dl>
    {(h.review>0||h.mode_blocked>0||h.oldest_pending_seconds>60||h.legacy_unfinished>0)&&<p className="rounded-lg border border-amber-500/30 p-3 text-xs">{t('intakeAttention')}</p>}
    <section className="rounded-lg border p-3 space-y-2"><h3 className="font-medium text-sm">{t('intakeLatency')}</h3><p className="text-xs text-muted-foreground">{t('intakeLatencySample')} · {fmt(h.latency_sample.count)}</p>{h.latency_sample.count>0?<dl className="grid grid-cols-3 gap-2 text-xs">{([['intakeQueueDelay',h.latency_sample.avg_queue_ms],['intakeProcessingDelay',h.latency_sample.avg_processing_ms],['intakeMaxProcessing',h.latency_sample.max_processing_ms]] as const).map(([label,value])=><div key={label}><dt className="text-muted-foreground">{t(label)}</dt><dd className="mt-1 font-medium tabular-nums" dir="ltr">{fmt(value)} ms</dd></div>)}</dl>:<p className="text-xs text-muted-foreground">{t('intakeNoSample')}</p>}</section>
    <section className="space-y-2"><h3 className="font-semibold">{t('intakeCases')}</h3><p className="text-xs text-muted-foreground">{t('intakeCaseNotice')}</p>{!page.maintenance_ready&&(h.review>0||h.legacy_unfinished>0)&&<p className="text-xs text-muted-foreground">{t('intakeMaintenanceRequired')}</p>}{page.items.length===0&&<p className="py-4 text-center text-xs text-muted-foreground">{t('intakeNoCases')}</p>}{page.items.map(row=><ReviewCase key={row.id+':'+row.state+':'+row.reason+':'+row.can_close+':'+page.maintenance_ready} row={row} ctx={ctx} allowed={page.maintenance_ready} onClosed={changed}/>)}</section>
    <nav aria-label={t('readinessPages')} className="flex justify-between gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={trail.length<2} onClick={()=>{setTrail(x=>x.slice(0,-1));setRev(x=>x+1)}}>{t('readinessPrevious')}</Button><span className="self-center text-xs text-muted-foreground">{trail.length}</span><Button type="button" variant="outline" className="min-h-11" disabled={!page.next_after} onClick={()=>{if(page.next_after){setTrail(x=>[...x,page.next_after]);setRev(x=>x+1)}}}>{t('readinessNext')}</Button></nav>
   </fieldset>}
  </DialogContent>
 </Dialog>
}
