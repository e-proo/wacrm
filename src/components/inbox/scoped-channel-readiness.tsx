'use client'
import { useEffect,useState } from 'react'
import { useLocale,useTranslations } from 'next-intl'
import { CheckCircle2,AlertCircle,RefreshCw,ShieldCheck } from 'lucide-react'
import { useCan } from '@/hooks/use-can'
import { Button } from '@/components/ui/button'
import { Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle,DialogTrigger } from '@/components/ui/dialog'
import { fetchInbox,type InboxContext } from '@/lib/inbox/scoped-list-model'
import { normalizeReadinessPage,readinessReasons,readinessCapabilities,type ReadinessPage,type ReadinessGates,type ReadinessRow } from '@/lib/inbox/channel-readiness-model'
import { ScopedVerifyChannel } from './scoped-verify-channel'
import { cn } from '@/lib/utils'

function Indicator({ok,label}:{ok:boolean;label:string}){
 const Icon=ok?CheckCircle2:AlertCircle
 return <span className={cn('inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs',ok?'border-emerald-500/25 text-emerald-700 dark:text-emerald-300':'border-amber-500/30 text-amber-800 dark:text-amber-300')}><Icon className="size-3.5 shrink-0" aria-hidden="true"/>{label}</span>
}
function timestamp(value:string|null,locale:string){
 return value?new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'—'
}
function ReadinessCard({row,gates,ctx,onChanged}:{row:ReadinessRow;gates:ReadinessGates;ctx:InboxContext;onChanged:(kind:'verified'|'revoked')=>void}){
 const t=useTranslations('Inbox.scoped'),locale=useLocale()
 const reasons=readinessReasons(row),caps=readinessCapabilities(row,gates)
 const [confirm,setConfirm]=useState(false),[maintenance,setMaintenance]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null)
 const isOpenWA=row.provider==='openwa'
 async function revoke(){
  if(!caps.revoke||!row.membership_id||!maintenance||busy)return
  setBusy(true);setError(null)
  try{
   const response=await fetch('/api/inbox/channel-readiness',{method:'POST',credentials:'same-origin',cache:'no-store',
    headers:{'content-type':'application/json','x-wacrm-inbox-account':ctx.accountId,'x-wacrm-inbox-actor':ctx.userId},
    body:JSON.stringify({connectionId:row.id,membershipId:row.membership_id,wasPrimary:row.primary,confirmMaintenance:true})})
   const result:unknown=await response.json().catch(()=>null)
   if(!response.ok||!result||typeof result!=='object'||!('state' in result)||result.state!=='revoked'){
    const code=result&&typeof result==='object'&&'error' in result?result.error:null
    setError(code==='revocation_busy'?'readinessRevokeBusy':code==='revocation_conflict'?'readinessRevokeConflict':code==='maintenance_required'?'readinessMaintenanceRequired':'readinessRevokeFailed')
    return
   }
   setConfirm(false);setMaintenance(false);onChanged('revoked')
  }catch{setError('readinessRevokeFailed')}finally{setBusy(false)}
 }
 return <article className="min-w-0 rounded-xl border border-border bg-background p-4 space-y-3">
  <header className="flex flex-wrap items-start justify-between gap-2">
   <div className="min-w-0"><h3 className="break-words font-semibold" dir="auto">{row.display_name||t('unnamedSession')}</h3><p className="text-[11px] text-muted-foreground" dir="ltr">{row.provider==='openwa'?'OpenWA':'Meta Cloud'} · {row.id.slice(0,8)}</p></div>
   <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium',reasons.length?'bg-amber-500/10 text-amber-800 dark:text-amber-300':'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300')}>{t(reasons.length?'readinessNeedsAttention':isOpenWA?'readinessConfigured':'readinessMetaVerified')}</span>
  </header>
  <div className="flex flex-wrap gap-1.5">
   <Indicator ok={row.online} label={t(row.online?'online':'offline')}/>
   <Indicator ok={row.identity_verified} label={t(row.identity_verified?'verifiedChannel':'unverified')}/>
   {isOpenWA&&<><Indicator ok={row.namespace_contract_verified} label={t(row.namespace_contract_verified?'readinessNamespaceVerified':'readinessNamespaceMissing')}/>
   <Indicator ok={row.primary} label={t(row.primary?'primary':'readinessPrimaryMissing')}/>
   <Indicator ok={row.signed_webhook_configured===true} label={t(row.signed_webhook_configured?'readinessWebhookConfigured':'readinessNoWebhook')}/></>}
  </div>
  <dl className="grid grid-cols-2 gap-3 rounded-lg bg-muted/40 p-3 text-xs sm:grid-cols-3">
   {isOpenWA&&<><div><dt className="text-muted-foreground">{t('readinessEngine')}</dt><dd className="mt-1 font-medium break-words" dir="ltr">{row.engine||'—'}</dd></div>
   <div><dt className="text-muted-foreground">{t('readinessVersion')}</dt><dd className="mt-1 font-medium" dir="ltr">{row.gateway_version||'—'}</dd></div>
   <div><dt className="text-muted-foreground">{t('readinessHeld')}</dt><dd className="mt-1 font-medium tabular-nums">{row.held_count_capped===101?'100+':row.held_count_capped}</dd></div></>}
   <div><dt className="text-muted-foreground">{t('readinessIdentityAt')}</dt><dd className="mt-1 break-words font-medium">{timestamp(row.identity_verified_at,locale)}</dd></div>
   {isOpenWA&&<div><dt className="text-muted-foreground">{t('readinessProofAt')}</dt><dd className="mt-1 break-words font-medium">{timestamp(row.namespace_verified_at,locale)}</dd></div>}
   {row.last_closed_at&&<div><dt className="text-muted-foreground">{t('readinessClosedAt')}</dt><dd className="mt-1 break-words font-medium">{timestamp(row.last_closed_at,locale)}</dd></div>}
  </dl>
  {reasons.length>0&&<div className="space-y-1"><h4 className="text-xs font-semibold">{t('readinessReasons')}</h4><ul className="list-disc space-y-1 ps-5 text-xs text-muted-foreground">{reasons.map(reason=><li key={reason}>{t(reason)}</li>)}</ul></div>}
  {row.handover_blocked&&<p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-xs">{t('readinessHandoverNotice')}</p>}
  {isOpenWA&&row.held_count_capped>0&&<p className="text-xs text-muted-foreground">{t('readinessHeldNotice')}</p>}
  {(caps.verifyIdentity||caps.verifyPrimary)&&!confirm&&<ScopedVerifyChannel connectionId={row.id} ctx={ctx} identityUnverified={caps.verifyIdentity} openwa={caps.verifyPrimary} onVerified={()=>onChanged('verified')}/>}
  {isOpenWA&&row.membership_id!==null&&<div className="border-t border-border pt-3">
   {!caps.revoke?<p className="text-xs text-muted-foreground">{t('readinessMaintenanceRequired')}</p>:!confirm?
   <Button type="button" className="min-h-11" variant="outline" onClick={()=>{setConfirm(true);setError(null)}}>{t('readinessRevoke')}</Button>:
   <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2">
    <p className="text-xs">{t('readinessRevokeNotice')}</p>
    <label className="flex min-h-11 items-start gap-2 text-xs"><input type="checkbox" className="mt-1 size-4 shrink-0" checked={maintenance} disabled={busy} onChange={e=>setMaintenance(e.target.checked)}/><span>{t('readinessMaintenanceConfirm')}</span></label>
    <div className="flex flex-wrap gap-2"><Button type="button" variant="destructive" className="min-h-11" disabled={!maintenance||busy} onClick={()=>void revoke()}>{busy?t('loading'):t('readinessConfirmRevoke')}</Button>
    <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={()=>{setConfirm(false);setMaintenance(false);setError(null)}}>{t('actionCancelReply')}</Button></div>
    {error&&<p role="alert" className="text-xs text-destructive">{t(error)}</p>}
   </div>}
  </div>}
 </article>
}
export function ScopedChannelReadiness({ctx,revision,onChanged}:{ctx:InboxContext;revision:number;onChanged:()=>void}){
 const t=useTranslations('Inbox.scoped')
 const authorized=useCan('edit-settings')
 const [open,setOpen]=useState(false),[localRevision,setLocalRevision]=useState(0),[trail,setTrail]=useState<(string|null)[]>([null])
 const [snapshot,setSnapshot]=useState<{key:string;page:ReadinessPage|null;error:boolean}|null>(null)
 const [notice,setNotice]=useState<'verified'|'revoked'|null>(null)
 const after=trail.at(-1)??null,key=[ctx.accountId,ctx.userId,revision,localRevision,after].join(':')
 useEffect(()=>{
  if(!open||!authorized)return
  const ctl=new AbortController()
  void fetchInbox<unknown>('channel-readiness'+(after?'?after='+encodeURIComponent(after):''),{accountId:ctx.accountId,userId:ctx.userId},ctl.signal)
   .then(raw=>{const page=normalizeReadinessPage(raw);if(!page)throw Error('invalid readiness');if(!ctl.signal.aborted)setSnapshot({key,page,error:false})})
   .catch(()=>{if(!ctl.signal.aborted)setSnapshot({key,page:null,error:true})})
  return()=>ctl.abort()
 },[open,authorized,key,after,ctx.accountId,ctx.userId])
 if(!authorized)return null
 const current=snapshot?.key===key?snapshot:null,page=current?.page
 function changed(kind:'verified'|'revoked'){setNotice(kind);setLocalRevision(x=>x+1);onChanged()}
 return <Dialog open={open} onOpenChange={v=>{setOpen(v);if(v){setTrail([null]);setLocalRevision(x=>x+1);setNotice(null)}}}>
  <DialogTrigger render={<Button type="button" variant="outline" className="min-h-11 w-full justify-start gap-2"/>}><ShieldCheck className="size-4 shrink-0"/>{t('readinessTitle')}</DialogTrigger>
  <DialogContent className="max-h-[min(90dvh,54rem)] overflow-y-auto overscroll-contain pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-w-3xl">
   <DialogHeader className="pe-8"><DialogTitle>{t('readinessTitle')} · TEST</DialogTitle><DialogDescription>{t('readinessDescription')}</DialogDescription></DialogHeader>
   <div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{t('readinessSnapshotNotice')}</p><Button type="button" variant="outline" size="sm" className="min-h-11 shrink-0 gap-1.5" onClick={()=>setLocalRevision(x=>x+1)}><RefreshCw className="size-4"/>{t('readinessRefresh')}</Button></div>
   {notice&&<p role="status" className="rounded-md bg-muted p-2 text-sm">{t(notice==='verified'?'readinessUpdated':'readinessRevoked')}</p>}
   {!current&&<p role="status" className="rounded-lg bg-muted/40 p-4 text-center text-sm">{t('loading')}</p>}
   {current?.error&&<div role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm">{t('readinessLoadFailed')} <Button type="button" variant="outline" className="mt-2 min-h-11" onClick={()=>setLocalRevision(x=>x+1)}>{t('retry')}</Button></div>}
   {page&&<>
    <section className="rounded-xl border border-border bg-muted/30 p-3 space-y-2"><h3 className="text-xs font-semibold">{t('readinessRuntime')}</h3>
     <div className="flex flex-wrap gap-2"><Indicator ok={page.gates.shadow} label={t(page.gates.shadow?'readinessShadowOn':'readinessShadowOff')}/><Indicator ok={page.gates.canonical} label={t(page.gates.canonical?'readinessCanonicalOn':'readinessCanonicalOff')}/><span className="rounded-md border px-2 py-1 text-xs">{t(page.gates.actions?'readinessActionsOn':'readinessActionsOff')}</span><span className="rounded-md border px-2 py-1 text-xs">{t(page.gates.durable?'intakeEnabled':'intakeDisabled')}</span></div>
     <p className="text-xs text-muted-foreground">{t('readinessGateNotice')}</p>
    </section>
    {page.items.length===0&&<p className="py-6 text-center text-sm text-muted-foreground">{t('emptySessions')}</p>}
    <div className="space-y-3">{page.items.map(row=><ReadinessCard key={row.id+':'+(row.membership_id??'none')+':'+row.primary} row={row} gates={page.gates} ctx={ctx} onChanged={changed}/>)}</div>
    <nav aria-label={t('readinessPages')} className="flex flex-wrap justify-between gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={trail.length<2} onClick={()=>setTrail(x=>x.slice(0,-1))}>{t('readinessPrevious')}</Button><span className="self-center text-xs text-muted-foreground tabular-nums">{trail.length}</span><Button type="button" variant="outline" className="min-h-11" disabled={!page.next_after} onClick={()=>{if(page.next_after)setTrail(x=>[...x,page.next_after])}}>{t('readinessNext')}</Button></nav>
   </>}
  </DialogContent>
 </Dialog>
}
