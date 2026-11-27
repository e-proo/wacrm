'use client'
import {useState} from 'react'
import {useLocale,useTranslations} from 'next-intl'
import {ClipboardCheck,RefreshCw} from 'lucide-react'
import {useCan} from '@/hooks/use-can'
import {Button} from '@/components/ui/button'
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle,DialogTrigger} from '@/components/ui/dialog'
import type {InboxContext} from '@/lib/inbox/scoped-list-model'
import {useAdminSnapshot} from '@/lib/inbox/use-admin-snapshot'
import {normalizeReviewPage,reviewAction,type ReviewPage,type ReviewRow,type ReviewOutcome} from '@/lib/inbox/intake-review-model'

// A response for the other tab must never be shown in this tab.
function normalizePendingReview(raw:unknown):ReviewPage|null{const p=normalizeReviewPage(raw);return p?.closed===false?p:null}
function normalizeClosedReview(raw:unknown):ReviewPage|null{const p=normalizeReviewPage(raw);return p?.closed===true?p:null}

const reasonKeys={
 missing_verified_epoch:'reviewMissingEpoch',event_only_identity:'reviewEventOnly',namespace_unverified:'reviewMissingNamespace',peer_conflict:'reviewPeerConflict',
 receipt_conflict:'reviewReceiptConflict',legacy_collision:'reviewLegacyCollision',outbound_echo_unproven:'reviewEchoUnproven',reaction_unproven:'reviewReactionUnproven',
 source_unconfirmed:'reviewSourceUnconfirmed',payload_changed:'reviewPayloadChanged',primary_unavailable:'reviewPrimaryUnavailable'
} as const
const decisionKeys={busy:'reviewBusy',unverified:'reviewUnverified',duplicate:'reviewDuplicateEligible',restore:'reviewRestoreEligible',closed:'reviewClosed'} as const
const outcomeKeys={restored_history:'reviewRestored',duplicate_confirmed:'reviewDuplicateConfirmed',closed_unverified:'reviewClosedUnverified',system_resolved:'reviewSystemResolved'} as const
const actionKeys={restore:'reviewRestore',duplicate:'reviewSettleDuplicate',close_unverified:'reviewCloseUnverified'} as const
const noticeKeys={restore:'reviewRestoreNotice',duplicate:'reviewDuplicateNotice',close_unverified:'reviewCloseNotice'} as const
function ReviewCard({row,maintenance,ctx,onSettled}:{row:ReviewRow;maintenance:boolean;ctx:InboxContext;onSettled:(outcome:ReviewOutcome)=>void}){
 const t=useTranslations('Inbox.scoped'),locale=useLocale()
 const action=reviewAction(row,maintenance)
 const [confirm,setConfirm]=useState(false),[checked,setChecked]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[requestId,setRequestId]=useState<string|null>(null)
 const format=(at:string)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(new Date(at))
 async function settle(){
  if(!action||!checked||busy)return
  const key=requestId??crypto.randomUUID()
  setRequestId(key);setBusy(true);setError(null)
  try{
   const response=await fetch('/api/inbox/intake-review',{method:'POST',credentials:'same-origin',cache:'no-store',
    headers:{'content-type':'application/json','x-wacrm-inbox-account':ctx.accountId,'x-wacrm-inbox-actor':ctx.userId},
    body:JSON.stringify({receiptId:row.id,action,requestId:key,confirmMaintenance:true})})
   const result:unknown=await response.json().catch(()=>null)
   const expected=action==='restore'?'restored_history':action==='duplicate'?'duplicate_confirmed':'closed_unverified'
   if(!response.ok||!result||typeof result!=='object'||!('state' in result)||result.state!=='settled'||!('outcome' in result)||result.outcome!==expected){
    const code=result&&typeof result==='object'&&'error' in result?result.error:null
    setError(code==='review_busy'?'reviewBusy':code==='review_conflict'?'reviewConflict':code==='maintenance_required'?'readinessMaintenanceRequired':'reviewFailed')
    return
   }
   setConfirm(false);setChecked(false);onSettled(expected)
  }catch{setError('reviewFailed')}finally{setBusy(false)}
 }
 return <article className="space-y-3 rounded-xl border border-border bg-background p-4">
  <header className="flex flex-wrap items-start justify-between gap-2">
   <div className="min-w-0"><h3 className="break-words font-semibold" dir="auto">{row.display_name||t('unnamedSession')}</h3><p className="text-xs text-muted-foreground" dir="ltr">OpenWA · {row.id.slice(0,8)}</p></div>
   <span className="rounded-full border px-2.5 py-1 text-xs font-medium">{t(row.outcome?outcomeKeys[row.outcome]:decisionKeys[row.decision])}</span>
  </header>
  <div className="rounded-lg bg-muted/40 p-3 space-y-1 text-sm"><p className="font-medium">{t(reasonKeys[row.reason])}</p><p className="break-all text-xs text-muted-foreground" dir="ltr">{row.reason}</p></div>
  <dl className="grid grid-cols-2 gap-3 text-xs"><div><dt className="text-muted-foreground">{t('reviewReceivedAt')}</dt><dd className="mt-1">{format(row.created_at)}</dd></div><div><dt className="text-muted-foreground">{t('reviewKind')}</dt><dd className="mt-1" dir="ltr">{row.message_kind}</dd></div>{row.resolved_at&&<div><dt className="text-muted-foreground">{t('reviewResolvedAt')}</dt><dd className="mt-1">{format(row.resolved_at)}</dd></div>}</dl>
  {row.preview!==null&&<details className="rounded-md border p-2 text-sm"><summary className="min-h-11 cursor-pointer py-2 text-xs font-medium">{t('reviewPreview')}</summary><p dir="auto" className="whitespace-pre-wrap break-words text-muted-foreground">{row.preview}</p></details>}
  {row.decision==='unverified'&&<p className="text-xs text-muted-foreground">{t('reviewNoProofNotice')}</p>}
  {row.outcome==='closed_unverified'&&<p className="text-xs text-muted-foreground">{t('reviewCloseNotice')}</p>}
  {row.outcome==='restored_history'&&<p className="text-xs text-muted-foreground">{t('reviewRestoreNotice')}</p>}
  {action&&!confirm&&<Button type="button" className="min-h-11" variant="outline" onClick={()=>{setConfirm(true);setError(null)}}>{t(actionKeys[action])}</Button>}
  {action&&confirm&&<div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
   <p className="text-xs">{t(noticeKeys[action])}</p>
   <label className="flex min-h-11 items-start gap-2 text-xs"><input type="checkbox" className="mt-1 size-4 shrink-0" checked={checked} disabled={busy} onChange={e=>setChecked(e.target.checked)}/><span>{t('reviewMaintenanceConfirm')}</span></label>
   <div className="flex flex-wrap gap-2"><Button type="button" className="min-h-11" disabled={!checked||busy} onClick={()=>void settle()}>{busy?t('loading'):t('reviewConfirm')}</Button>
    <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={()=>{setConfirm(false);setChecked(false);setError(null)}}>{t('actionCancelReply')}</Button></div>
   {error&&<p role="alert" className="text-xs text-destructive">{t(error)}</p>}
  </div>}
 </article>
}
export function ScopedIntakeReview({ctx,onChanged}:{ctx:InboxContext;onChanged:()=>void}){
 const t=useTranslations('Inbox.scoped'),authorized=useCan('edit-settings')
 const [open,setOpen]=useState(false),[closed,setClosed]=useState(false),[localRevision,setLocalRevision]=useState(0),[trail,setTrail]=useState<(string|null)[]>([null])
 const [notice,setNotice]=useState<ReviewOutcome|null>(null)
 const after=trail.at(-1)??null
 const q=new URLSearchParams({closed:String(closed)})
 if(after)q.set('after',after)
 const {page,refreshing,error}=useAdminSnapshot(ctx,open&&authorized,'intake-review?'+q.toString(),localRevision,closed?normalizeClosedReview:normalizePendingReview)
 if(!authorized)return null

 function changed(outcome:ReviewOutcome){setNotice(outcome);setTrail([null]);setLocalRevision(x=>x+1);onChanged()}
 return <Dialog open={open} onOpenChange={v=>{setOpen(v);if(v){setClosed(false);setTrail([null]);setLocalRevision(x=>x+1);setNotice(null)}}}>
  <DialogTrigger render={<Button type="button" variant="outline" className="min-h-11 w-full justify-start gap-2"/>}><ClipboardCheck className="size-4 shrink-0"/>{t('reviewTitle')}</DialogTrigger>
  <DialogContent className="max-h-[min(90dvh,54rem)] overflow-y-auto overscroll-contain pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-w-3xl">
   <DialogHeader className="pe-8"><DialogTitle>{t('reviewTitle')} · TEST</DialogTitle><DialogDescription>{t('reviewDescription')}</DialogDescription></DialogHeader>
   <div className="flex flex-wrap items-center justify-between gap-2"><div role="group" aria-label={t('reviewTitle')} className="flex gap-1 rounded-lg bg-muted p-1">{([false,true] as const).map(v=><Button key={String(v)} type="button" variant={closed===v?'default':'ghost'} className="min-h-11" aria-pressed={closed===v} onClick={()=>{setClosed(v);setTrail([null]);setNotice(null);setLocalRevision(x=>x+1)}}>{t(v?'reviewClosed':'reviewPending')}</Button>)}</div>
    <Button type="button" variant="outline" className="min-h-11 gap-1.5" disabled={refreshing} aria-busy={refreshing} onClick={()=>setLocalRevision(x=>x+1)}><RefreshCw aria-hidden="true" className={refreshing?'size-4 animate-spin motion-reduce:animate-none':'size-4'}/>{t('readinessRefresh')}</Button></div>
   {notice&&<p role="status" className="rounded-lg bg-muted p-3 text-sm">{t(outcomeKeys[notice])}</p>}
   {refreshing&&!page&&<p role="status" className="p-4 text-center text-sm">{t('loading')}</p>}
   {error&&<div role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm">{t('reviewLoadFailed')} <Button type="button" variant="outline" className="mt-2 min-h-11" onClick={()=>setLocalRevision(x=>x+1)}>{t('retry')}</Button></div>}
   {page&&<fieldset disabled={refreshing} aria-busy={refreshing} className="min-w-0 space-y-3 border-0 p-0">
    {!page.maintenance_ready&&!closed&&<p className="rounded-lg border border-amber-500/30 p-3 text-xs">{t('reviewMaintenanceRequired')}</p>}
    {page.items.length===0&&<p className="p-5 text-center text-sm text-muted-foreground">{t(closed?'reviewEmptyClosed':'reviewEmptyPending')}</p>}
    <div className="space-y-3">{page.items.map(row=><ReviewCard key={row.id+':'+row.decision+':'+row.reason+':'+row.outcome+':'+page.maintenance_ready} row={row} ctx={ctx} maintenance={page.maintenance_ready} onSettled={changed}/>)}</div>
    <nav aria-label={t('readinessPages')} className="flex flex-wrap justify-between gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={trail.length<2} onClick={()=>{setTrail(x=>x.slice(0,-1));setLocalRevision(x=>x+1)}}>{t('readinessPrevious')}</Button><span className="self-center text-xs text-muted-foreground">{trail.length}</span><Button type="button" variant="outline" className="min-h-11" disabled={!page.next_after} onClick={()=>{if(page.next_after){setTrail(x=>[...x,page.next_after]);setLocalRevision(x=>x+1)}}}>{t('readinessNext')}</Button></nav>
   </fieldset>}
  </DialogContent>
 </Dialog>
}
