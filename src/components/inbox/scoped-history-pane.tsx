'use client'
import { useEffect,useLayoutEffect,useRef,useState } from 'react'
import { useLocale,useTranslations } from 'next-intl'
import { Check,CheckCheck,Clock,Reply,XCircle,Copy,SmilePlus } from 'lucide-react'
import { ReplyQuote } from './reply-quote'
import {MediaAudioBubble,MediaDocumentBubble,MediaImageBubble,MediaVideoBubble,MediaUnavailable} from './message-media'
import {MediaLightbox} from './media-lightbox'
import type {MediaGalleryItem} from '@/lib/media/gallery'
import type {MediaFilenameInput} from '@/lib/media/filename'
import {Popover,PopoverTrigger,PopoverContent} from '@/components/ui/popover'
import {toast} from 'sonner'
import { conversationDay,quotePreview } from '@/lib/inbox/scoped-conversation-model'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { canAcknowledge,submitScopedRead,type HistoryMessage } from '@/lib/inbox/scoped-history-model'
import { useScopedHistory } from '@/lib/inbox/use-scoped-history'
import type { InboxContext,ScopedRow } from '@/lib/inbox/scoped-list-model'

type Anchor={bottom:boolean;id:string|null;offset:number;top:number}
type MessageActions={canReply:boolean;canRead:boolean;canReact:boolean;onReply:(m:HistoryMessage)=>void;onNative:(kind:'provider_read'|'reaction',m:HistoryMessage,emoji?:string)=>void;busy:boolean}
function scopedMedia(message:HistoryMessage):MediaFilenameInput|null{
 const kind=message.content_type
 if(kind!=='image'&&kind!=='video'&&kind!=='audio'&&kind!=='document')return null
 return {content_type:kind,media_url:message.media_url??undefined,content_text:message.content_text??undefined,media_type:message.media_type,created_at:message.created_at??''}
}
function Message({message,quote,actions,onJump,onOpenMedia}:{message:HistoryMessage;quote:HistoryMessage|undefined;actions?:MessageActions;onJump:(id:string)=>void;onOpenMedia:(id:string)=>void}){
 const t=useTranslations('Inbox.scoped'),a=useTranslations('Inbox.actions'),locale=useLocale(),incoming=message.sender_type==='customer'
 const [picker,setPicker]=useState(false),[touchOpen,setTouchOpen]=useState(false)
 const b=useTranslations('Inbox.bubble'),media=scopedMedia(message)
 const time=message.created_at?new Date(message.created_at):null
 const hold=useRef<{timer:ReturnType<typeof setTimeout>;x:number;y:number}|null>(null)
 const cancelHold=()=>{if(hold.current){clearTimeout(hold.current.timer);hold.current=null}}
 useEffect(()=>()=>{if(hold.current)clearTimeout(hold.current.timer)},[])
 useEffect(()=>{if(!actions?.canReply||actions.busy){if(hold.current)clearTimeout(hold.current.timer);hold.current=null}},[actions?.canReply,actions?.busy])
 const deliveryLabels:Record<string,string>={sending:t('actionStatusSending'),sent:t('actionStatusSent'),delivered:t('actionStatusDelivered'),read:t('actionStatusRead'),replied:t('actionStatusReplied'),failed:t('actionStatusFailed')}
 const deliveryLabel=deliveryLabels[message.status]??t('actionStatusUnknown')
 return <div data-message-id={message.id} tabIndex={-1}
  onPointerDown={e=>{if(e.pointerType!=='touch'||!actions?.canReply||actions.busy||(e.target as HTMLElement).closest('button,a,input,video,audio'))return;cancelHold();hold.current={x:e.clientX,y:e.clientY,timer:setTimeout(()=>{hold.current=null;setTouchOpen(true);actions.onReply(message)},550)}}}
  onPointerMove={e=>{if(hold.current&&(Math.abs(e.clientX-hold.current.x)>10||Math.abs(e.clientY-hold.current.y)>10))cancelHold()}}
  onPointerUp={cancelHold} onPointerCancel={cancelHold} onPointerLeave={cancelHold} className={cn('flex w-full scroll-m-4 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring',incoming?'justify-start':'justify-end')}>
  <div className="group/message relative min-w-0 max-w-[85%] sm:max-w-[75%]"><div className={cn('relative min-w-0 space-y-1 rounded-2xl px-3 py-2',incoming?'rounded-es-md bg-muted text-foreground':'rounded-ee-md bg-primary text-primary-foreground')}>
   {message.reply_to_message_id&&(quote?<button type="button" className="block w-full min-w-0 text-start focus-visible:ring-2 focus-visible:ring-ring" onClick={()=>onJump(quote.id)}><ReplyQuote authorLabel={t(quote.sender_type==='customer'?'incoming':'outgoing')} preview={quotePreview(quote,t('replyNotLoaded'))} onPrimary={!incoming}/></button>:<ReplyQuote authorLabel={t('reply')} preview={t('replyNotLoaded')} onPrimary={!incoming}/> )}
   {media?<div className="min-w-0">
    {!media.media_url?<MediaUnavailable label={message.content_type==='document'?message.content_text||b('document'):b(message.content_type==='image'?'photo':message.content_type==='video'?'video':'audio')} t={b}/>:media.content_type==='image'?<MediaImageBubble message={media} fresh onOpen={()=>onOpenMedia(message.id)} t={b}/>:media.content_type==='video'?<MediaVideoBubble message={media} fresh onOpen={()=>onOpenMedia(message.id)} t={b}/>:media.content_type==='audio'?<MediaAudioBubble message={media} fresh t={b}/>:<MediaDocumentBubble message={media} fresh t={b}/>}
    {(media.content_type==='image'||media.content_type==='video')&&message.content_text&&<p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm" dir="auto">{message.content_text}</p>}
   </div>:<>{message.content_text&&<p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm" dir="auto">{message.content_text}</p>}{message.media_url?<a href={message.media_url} target="_blank" rel="noopener noreferrer" className="text-xs underline">{t('openMedia')}</a>:message.has_media?<p className="text-xs opacity-70">{t('mediaUnavailable')}</p>:!message.content_text?<p className="text-xs opacity-70">[{message.content_type}]</p>:null}</>}
   {!!message.reactions.length&&<div className="flex flex-wrap gap-1">{message.reactions.map(r=><span key={r.emoji} className={cn('rounded-full border px-1.5 text-xs',r.mine?'border-primary bg-primary/10':'border-border bg-muted')}>{r.emoji} {r.count}</span>)}</div>}
   <div className={cn('mt-1 flex flex-wrap items-center gap-1 text-[10px]',incoming?'justify-start text-muted-foreground':'justify-end text-primary-foreground/70')}><span>{time&&!Number.isNaN(time.getTime())?new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit'}).format(time):''}</span>{!incoming&&<span className={cn('rounded px-1',message.status==='failed'?'text-red-300':'text-primary-foreground/70')} aria-label={t('actionDeliveryStatus')+': '+deliveryLabel} title={deliveryLabel}><span className="inline-flex items-center gap-1">{message.status==='sending'?<Clock className="size-3"/>:message.status==='failed'?<XCircle className="size-3"/>:message.status==='sent'?<Check className="size-3"/>:['delivered','read'].includes(message.status)?<CheckCheck className={cn('size-3',message.status==='read'&&'text-blue-500')}/>:null}<span className="sr-only">{deliveryLabel}</span></span></span>}</div>
  </div>
   {actions&&(actions.canReply||actions.canRead||actions.canReact)&&<div role="group" aria-label={t('actionMessageActions')} className={cn('absolute -top-3 z-10 flex min-h-7 items-center gap-0.5 rounded-full border border-border bg-popover/95 px-1 text-popover-foreground shadow-md backdrop-blur-sm transition-opacity',incoming?'start-3':'end-3',touchOpen||picker?'opacity-100':'opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100 [@media(hover:none)]:opacity-100')}>
    {actions.canReact&&<Popover open={picker} onOpenChange={setPicker}><PopoverTrigger disabled={actions.busy} className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-muted" aria-label={t('actionReact')}><SmilePlus className="size-3.5"/></PopoverTrigger><PopoverContent className="flex w-auto gap-1 p-1.5">{['👍','❤️','😂','😮','😢','🙏',...(message.reactions.some(r=>r.mine)?['']:[])].map(emoji=><button type="button" key={emoji} disabled={actions.busy} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted" aria-label={emoji?a('reactWith',{emoji}):t('actionRemoveReaction')} onClick={()=>{actions.onNative('reaction',message,emoji);setPicker(false);setTouchOpen(false)}}>{emoji||'×'}</button>)}</PopoverContent></Popover>}
    {actions.canReply&&<button type="button" className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-muted" disabled={actions.busy} onClick={()=>{actions.onReply(message);setTouchOpen(false)}} aria-label={t('reply')} title={t('reply')}><Reply className="size-3.5"/></button>}
    {message.content_text&&<button type="button" className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-muted" aria-label={a('copyText')} title={a('copyText')} onClick={()=>{void navigator.clipboard.writeText(message.content_text??'').then(()=>toast.success(a('copied'))).catch(()=>toast.error(a('copyFailed')));setTouchOpen(false)}}><Copy className="size-3.5"/></button>}
    {incoming&&actions.canRead&&<button type="button" className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-muted" disabled={actions.busy} onClick={()=>actions.onNative('provider_read',message)} aria-label={t('actionProviderRead')} title={t('actionProviderRead')}><CheckCheck className="size-3.5"/></button>}
   </div>}

  </div>
 </div>
}
export function ScopedHistoryPane({row,ctx,revision,onRefresh,actions}:{row:ScopedRow;ctx:InboxContext;revision:number;onRefresh:()=>void;actions?:MessageActions}){
 const t=useTranslations('Inbox.scoped'),locale=useLocale()
 const scroll=useRef<HTMLDivElement>(null),anchor=useRef<Anchor|null>(null),request=useRef<AbortController|null>(null)
 const [reading,setReading]=useState(false),[readError,setReadError]=useState(false)
 const [mediaId,setMediaId]=useState<string|null>(null)
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
 const gallery:MediaGalleryItem[]=chronological.flatMap(m=>{
  const media=scopedMedia(m)
  if(!media?.media_url||(media.content_type!=='image'&&media.content_type!=='video')||!m.created_at||!Number.isFinite(Date.parse(m.created_at)))return []
  return [{messageId:m.id,url:media.media_url,kind:media.content_type,caption:m.content_text??undefined,createdAt:m.created_at,fromCustomer:m.sender_type==='customer',message:media}]
 })
 const jump=(id:string)=>{
  const target=Array.from(scroll.current?.querySelectorAll<HTMLElement>('[data-message-id]')??[]).find(node=>node.dataset.messageId===id)
  target?.scrollIntoView({block:'center'})
  target?.focus({preventScroll:true})
 }
 return <div className="flex min-h-0 flex-1 flex-col">
  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
   <span className="text-xs text-muted-foreground">{row.scope==='active'?t('localReadNotice'):t('readOnly')}</span>
   {row.scope==='active'&&history.token&&<Button size="sm" variant="outline" className="min-h-11" disabled={reading||history.busy||history.error} onClick={()=>void read()}>{reading?t('loading'):t('markRead')}</Button>}
  </div>
  {readError&&<p role="alert" className="px-4 py-2 text-xs text-destructive">{t('readFailed')}</p>}
  <div ref={scroll} role="log" aria-label={t('actionMessageHistory')} aria-live="off" className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-background bg-[url('/inbox-doodle.svg')] bg-repeat p-4" aria-busy={history.busy}>
   <div className="space-y-2">
    {history.cursor&&<div className="text-center"><Button size="sm" variant="outline" disabled={history.busy} onClick={history.more}>{t('olderMessages')}</Button></div>}
    {history.busy&&<p role="status" className="text-center text-xs text-muted-foreground">{t('loading')}</p>}
    {history.error&&<div role="alert" className="space-y-2 text-center text-sm text-destructive"><p>{t('error')}</p><Button onClick={history.retry} variant="outline">{t('retry')}</Button></div>}
    {!history.busy&&!history.error&&!chronological.length&&<p className="py-8 text-center text-sm text-muted-foreground">{t('emptyHistory')}</p>}
    {chronological.map((message,index)=>{
     const day=conversationDay(message.created_at,locale)
     const previous=index?conversationDay(chronological[index-1].created_at,locale):null
     return <div key={message.id} className="space-y-2">{day&&day!==previous&&<div className="flex justify-center"><span className="rounded-full border border-border/70 bg-card px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">{day}</span></div>}<Message message={message} quote={message.reply_to_message_id?byId.get(message.reply_to_message_id):undefined} actions={actions} onJump={jump} onOpenMedia={setMediaId}/></div>
    })}
   </div>
  </div>
  <MediaLightbox items={gallery} activeId={mediaId} onActiveIdChange={setMediaId} contactLabel={row.contact.name||row.contact.phone} fresh/>
 </div>
}
