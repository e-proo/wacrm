'use client'
import { useEffect,useLayoutEffect,useRef,useState } from 'react'
import { useLocale,useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { canAcknowledge,submitScopedRead,type HistoryMessage } from '@/lib/inbox/scoped-history-model'
import { useScopedHistory } from '@/lib/inbox/use-scoped-history'
import type { InboxContext,ScopedRow } from '@/lib/inbox/scoped-list-model'

type Anchor={bottom:boolean;id:string|null;offset:number;top:number}
type MessageActions={canReply:boolean;canRead:boolean;canReact:boolean;onReply:(m:HistoryMessage)=>void;onNative:(kind:'provider_read'|'reaction',m:HistoryMessage,emoji?:string)=>void;busy:boolean}
function Message({message,quote,actions}:{message:HistoryMessage;quote:HistoryMessage|undefined;actions?:MessageActions}){
 const t=useTranslations('Inbox.scoped'),locale=useLocale(),incoming=message.sender_type==='customer'
 const time=message.created_at?new Date(message.created_at):null
 const deliveryLabels:Record<string,string>={sending:t('actionStatusSending'),sent:t('actionStatusSent'),delivered:t('actionStatusDelivered'),read:t('actionStatusRead'),replied:t('actionStatusReplied'),failed:t('actionStatusFailed')}
 const deliveryLabel=deliveryLabels[message.status]??t('actionStatusUnknown')
 return <div data-message-id={message.id} className={cn('flex',incoming?'justify-start':'justify-end')}>
  <div className={cn('max-w-[85%] space-y-1 rounded-xl border border-border px-3 py-2 shadow-sm sm:max-w-[70%]',incoming?'bg-card':'bg-primary/10')}>
   <p className="text-[10px] text-muted-foreground">{incoming?t('incoming'):t('outgoing')}</p>
   {message.reply_to_message_id&&<div className="rounded-md border-s-2 border-primary/60 bg-muted/60 p-2 text-xs text-muted-foreground"><p className="font-medium">{t('reply')}</p><p className="truncate" dir="auto">{quote?.content_text||t('replyNotLoaded')}</p></div>}
   {message.content_text&&<p className="whitespace-pre-wrap break-words text-sm" dir="auto">{message.content_text}</p>}
   {message.media_url?<a href={message.media_url} target="_blank" rel="noopener noreferrer" className="block break-words text-xs font-medium text-primary underline">{t('openMedia')}</a>:message.has_media?<p className="text-xs text-muted-foreground">{t('mediaUnavailable')}</p>:!message.content_text?<p className="text-xs text-muted-foreground">[{message.content_type}]</p>:null}
   {!!message.reactions.length&&<div className="flex flex-wrap gap-1">{message.reactions.map(r=><span key={r.emoji} className={cn('rounded-full border px-1.5 text-xs',r.mine?'border-primary bg-primary/10':'border-border bg-muted')}>{r.emoji} {r.count}</span>)}</div>}
   <div className="flex flex-wrap justify-end gap-2 text-[10px] text-muted-foreground"><span>{time&&!Number.isNaN(time.getTime())?new Intl.DateTimeFormat(locale,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(time):''}</span>{!incoming&&<span className={cn('rounded px-1',message.status==='failed'?'text-destructive':'text-muted-foreground')} aria-label={t('actionDeliveryStatus')}>{deliveryLabel}</span>}</div>
   {actions&&(actions.canReply||actions.canRead||actions.canReact)&&<div className="flex flex-wrap items-center justify-end gap-1 border-t border-border/50 pt-1 text-xs">
    {actions.canReply&&<Button type="button" size="sm" variant="ghost" disabled={actions.busy} onClick={()=>actions.onReply(message)}>{t('reply')}</Button>}
    {incoming&&actions.canRead&&<Button type="button" size="sm" variant="ghost" disabled={actions.busy} onClick={()=>actions.onNative('provider_read',message)}>{t('actionProviderRead')}</Button>}
    {actions.canReact&&<>
     <Button type="button" size="sm" variant="ghost" disabled={actions.busy} onClick={()=>actions.onNative('reaction',message,'👍')} aria-label={t('actionReact')}>👍</Button>
     <Button type="button" size="sm" variant="ghost" disabled={actions.busy} onClick={()=>actions.onNative('reaction',message,'❤️')} aria-label={t('actionReactHeart')}>❤️</Button>
     {message.reactions.some(r=>r.mine)&&<Button type="button" size="sm" variant="ghost" disabled={actions.busy} onClick={()=>actions.onNative('reaction',message,'')}>{t('actionRemoveReaction')}</Button>}
    </>}
   </div>}
  </div>
 </div>
}
export function ScopedHistoryPane({row,ctx,revision,onRefresh,actions}:{row:ScopedRow;ctx:InboxContext;revision:number;onRefresh:()=>void;actions?:MessageActions}){
 const t=useTranslations('Inbox.scoped')
 const scroll=useRef<HTMLDivElement>(null),anchor=useRef<Anchor|null>(null),request=useRef<AbortController|null>(null)
 const [reading,setReading]=useState(false),[readError,setReadError]=useState(false)
 const history=useScopedHistory(row,ctx,revision,()=>{
  const el=scroll.current
  if(!el)return
  const rect=el.getBoundingClientRect()
  const first=Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(node=>node.getBoundingClientRect().bottom>rect.top)
  anchor.current={bottom:el.scrollHeight-el.scrollTop-el.clientHeight<64,id:first?.dataset.messageId??null,offset:first?first.getBoundingClientRect().top-rect.top:0,top:el.scrollTop}
 })
 useLayoutEffect(()=>{
  const el=scroll.current,saved=anchor.current
  if(!el||history.busy)return
  if(!saved||saved.bottom)el.scrollTop=el.scrollHeight
  else{
   const target=Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(node=>node.dataset.messageId===saved.id)
   el.scrollTop=target?el.scrollTop+target.getBoundingClientRect().top-el.getBoundingClientRect().top-saved.offset:saved.top
  }
  anchor.current=null
 },[history.items,history.busy])
 useEffect(()=>()=>{request.current?.abort();request.current=null},[])
 async function read(){
  const token=history.token
  if(request.current||!token||!canAcknowledge(row,window.location.search,document.visibilityState==='visible',document.hasFocus(),token))return
  const controller=new AbortController()
  request.current=controller;setReading(true);setReadError(false)
  try{await submitScopedRead(row,ctx,token,controller.signal);if(!controller.signal.aborted)onRefresh()}
  catch{if(!controller.signal.aborted){setReadError(true);history.retry()}}
  finally{if(!controller.signal.aborted){setReading(false);request.current=null}}
 }
 const chronological=[...history.items].reverse()
 const byId=new Map(history.items.map(m=>[m.id,m]))
 return <div className="flex min-h-0 flex-1 flex-col">
  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
   <span className="text-xs text-muted-foreground">{row.scope==='active'?t('localReadNotice'):t('readOnly')}</span>
   {row.scope==='active'&&history.token&&<Button size="sm" variant="outline" disabled={reading||history.busy||history.error} onClick={()=>void read()}>{reading?t('loading'):t('markRead')}</Button>}
  </div>
  {readError&&<p role="alert" className="px-4 py-2 text-xs text-destructive">{t('readFailed')}</p>}
  <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto p-4" aria-busy={history.busy}>
   <div className="mx-auto max-w-3xl space-y-3">
    {history.cursor&&<div className="text-center"><Button size="sm" variant="outline" disabled={history.busy} onClick={history.more}>{t('olderMessages')}</Button></div>}
    {history.busy&&<p role="status" className="text-center text-xs text-muted-foreground">{t('loading')}</p>}
    {history.error&&<div role="alert" className="space-y-2 text-center text-sm text-destructive"><p>{t('error')}</p><Button onClick={history.retry} variant="outline">{t('retry')}</Button></div>}
    {!history.busy&&!history.error&&!chronological.length&&<p className="py-8 text-center text-sm text-muted-foreground">{t('emptyHistory')}</p>}
    {chronological.map(message=><Message key={message.id} message={message} quote={message.reply_to_message_id?byId.get(message.reply_to_message_id):undefined} actions={actions}/>)}
   </div>
  </div>
 </div>
}
