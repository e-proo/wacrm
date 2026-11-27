'use client'
import {useEffect,useRef,useState} from 'react'
import {useTranslations} from 'next-intl'
import {AlertTriangle,Paperclip,RefreshCw,Send,ShieldCheck,X,Smile,Zap,LayoutTemplate} from 'lucide-react'
import {Button} from '@/components/ui/button'
import {useInboxPages} from '@/lib/inbox/use-scoped-list'
import {fetchInbox,validId,type Connection,type InboxContext,type ScopedRow} from '@/lib/inbox/scoped-list-model'
import {uploadAccountMedia,deleteAccountMedia,MEDIA_MAX_BYTES_BY_KIND} from '@/lib/storage/upload-media'
import {submitScopedAction,inspectScopedAction,type ScopedActionOutcome,type ScopedActionRequest} from '@/lib/inbox/scoped-action-client'
import type {ActionScope} from '@/lib/inbox/action-intent-model'
import type {InboxCapabilities} from '@/lib/inbox/provider-policy-model'
import {validateInteractivePayload,type InteractiveMessagePayload} from '@/lib/whatsapp/interactive'
import {InteractiveBuilder,blankButtonsPayload} from '@/components/interactive/interactive-builder'
import {TemplatePicker} from './template-picker'
import {QuickReplyPicker} from './quick-reply-picker'
import {ReplyQuote} from './reply-quote'
import {ScopedVoiceRecorder} from './scoped-voice-recorder'
import {useCan} from '@/hooks/use-can'
import {getScopedAttachment,saveScopedAttachment,type ScopedAttachment} from '@/lib/inbox/scoped-attachment-memory'
import {metaWindow,quotePreview,sameReplyLane} from '@/lib/inbox/scoped-conversation-model'
import type {HistoryMessage} from '@/lib/inbox/scoped-history-model'
import {scopedDraftKey,getScopedDraft,saveScopedDraft,clearScopedDraft,containsUnsentDraft} from '@/lib/inbox/scoped-draft-memory'
import {useBrowserOnline} from '@/lib/inbox/scoped-connectivity'

export type ActiveActionScope={scope:ActionScope;capabilities:InboxCapabilities}
type Mode='text'|'media'|'template'|'interactive'
type Attachment=ScopedAttachment
type TemplateDraft={name:string;language:string;body:string[];headerText?:string;buttonParams?:Record<number,string>}
type Attempt={key:string;state:ScopedActionOutcome['state'];code?:string;mode?:Mode}
type SendPayload=Extract<ScopedActionRequest,{action:'send'}>['payload']
type Props={
 row:ScopedRow;ctx:InboxContext;revision:number;selectedConnection:string|null;onSelectConnection:(v:string|null)=>void
 reply:HistoryMessage|null;onClearReply:()=>void;onScopeChange:(value:ActiveActionScope|null)=>void;onRefresh:()=>void
}
function outcomeStorage(ctx:InboxContext,threadId:string){
 return 'wacrm:inbox-action:v1:'+ctx.accountId+':'+ctx.userId+':'+threadId
}
function cachedAttempt(key:string):Attempt|null{
 try{
  const raw=sessionStorage.getItem(key),v=JSON.parse(raw??'null') as Attempt|null
  return v&&validId(v.key)&&['pending','uncertain','blocked','unconfirmed','denied'].includes(v.state)?v:null
 }catch{return null}
}
// Only the UUID/status are stored; never the contact, content, media,
// recipient or credentials. A reload cannot silently recreate a send.
export function ScopedActionPane({row,ctx,revision,selectedConnection,onSelectConnection,reply,onClearReply,onScopeChange,onRefresh}:Props){
 const t=useTranslations('Inbox.scoped'),online=useBrowserOnline()
 const draftKey=scopedDraftKey(ctx,row.id,row.channel_id),key=outcomeStorage(ctx,row.id)
 const list=useInboxPages<Connection>('connections?scope=active&channel_id='+(row.channel_id??''),ctx,
  c=>c.channel_id===row.channel_id&&c.provider===row.provider,revision)
 const [policy,setPolicy]=useState<{key:string;capabilities:InboxCapabilities;seen:number}|null>(null)
 const [tick,setTick]=useState(0)
 const [mode,setMode]=useState<Mode>(()=>getScopedAttachment(draftKey)?'media':getScopedDraft(draftKey).mode)
 const [text,setText]=useState(()=>getScopedDraft(draftKey).text)
 const [attachment,setAttachmentState]=useState<Attachment|null>(()=>getScopedAttachment(draftKey))
 const [mediaKind,setMediaKind]=useState<Attachment['kind']>(()=>getScopedAttachment(draftKey)?.kind??'image')
 const setAttachment=(value:Attachment|null)=>{saveScopedAttachment(draftKey,value);setAttachmentState(value)}
 const [recording,setRecording]=useState(false)
 const canDraft=useCan('send-messages')
 const uploadLock=useRef(false),mounted=useRef(false)
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 const [caption,setCaption]=useState(()=>getScopedDraft(draftKey).caption)
 const [fileError,setFileError]=useState<string|null>(null)
 const [template,setTemplate]=useState<TemplateDraft|null>(null)
 const [templatePicker,setTemplatePicker]=useState(false)
 const [quickReplyPicker,setQuickReplyPicker]=useState(false)
 const [interactive,setInteractive]=useState<InteractiveMessagePayload>(blankButtonsPayload)
 const [uploading,setUploading]=useState(false)
 const [busy,setBusy]=useState(false)
 const sendLock=useRef(false)
 const textarea=useRef<HTMLTextAreaElement>(null)
 const [emojiOpen,setEmojiOpen]=useState(false)
 const composerT=useTranslations('Inbox.composer')
 const [attempt,setAttempt]=useState<Attempt|null>(()=>cachedAttempt(key))
 useEffect(()=>{saveScopedDraft(draftKey,{mode,text,caption})},[draftKey,mode,text,caption])
 useEffect(()=>{
  if(!containsUnsentDraft({mode,text,caption})&&!attachment)return
  const protect=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue=''}
  window.addEventListener('beforeunload',protect)
  return()=>window.removeEventListener('beforeunload',protect)
 },[mode,text,caption,attachment])
 useEffect(()=>{const timer=setInterval(()=>setTick(performance.now()),1000);return()=>clearInterval(timer)},[])
 const policyKey=ctx.accountId+':'+ctx.userId+':'+row.id+':'+row.channel_id+':'+(selectedConnection??'')+':'+revision
 useEffect(()=>{
  const ctl=new AbortController()
  setPolicy(null)
  onScopeChange(null)
  if(!row.channel_id||!selectedConnection||row.scope!=='active')return()=>ctl.abort()
   const url='threads/'+row.id+'/capabilities?channel_id='+encodeURIComponent(row.channel_id)+'&connection_id='+encodeURIComponent(selectedConnection)
  void fetchInbox<{capabilities:InboxCapabilities}>(url,ctx,ctl.signal).then(response=>{
   const c=response.capabilities
   if(!c||c.thread_id!==row.id||c.channel_id!==row.channel_id||c.connection_id!==selectedConnection||c.provider!==row.provider||!validId(c.membership_id))throw Error('Sender changed')
   if(ctl.signal.aborted)return
   const next={key:policyKey,capabilities:c,seen:performance.now()}
   setPolicy(next)
   onScopeChange({scope:{threadId:row.id,channelId:row.channel_id!,connectionId:selectedConnection,membershipId:c.membership_id!,provider:c.provider},capabilities:c})
  }).catch(()=>{if(!ctl.signal.aborted){setPolicy(null);onScopeChange(null)}})
  return()=>{ctl.abort();onScopeChange(null)}
 },[ctx.accountId,ctx.userId,row.id,row.channel_id,row.provider,row.scope,selectedConnection,revision,policyKey,onScopeChange])
 const connections=list.items
 const selected=connections.find(c=>c.id===selectedConnection)
 const active=policy?.key===policyKey?policy:null
 const c=active?.capabilities??null
 const windowInfo=metaWindow(c,active?Math.max(tick,active.seen)-active.seen:0)
 const remaining=windowInfo?.remaining??0
 const expired=windowInfo!==null&&!windowInfo.open
 const scope:ActionScope|null=c&&validId(c.membership_id)&&selectedConnection&&row.channel_id?{
  threadId:row.id,channelId:row.channel_id,connectionId:selectedConnection,membershipId:c.membership_id,provider:c.provider
 }:null
 const enabled=Boolean(online&&c?.dispatch_enabled&&scope&&selected?.ready&&!selected.archived)
 const kindAllowed=mode==='text'?Boolean(c?.may_send_text&&!expired):mode==='media'?Boolean(c?.may_send_media&&!expired&&c.media_kinds.includes(mediaKind)):mode==='template'?Boolean(c?.may_send_template):Boolean(c?.may_send_interactive&&!expired)
 const replyAllowed=!reply||Boolean(c?.may_reply&&sameReplyLane(reply,row.conversation_id,row.channel_id,row.provider))
 const canSubmit=Boolean(enabled&&kindAllowed&&replyAllowed&&!busy&&!uploading&&!recording&&!attempt&&(mode==='text'?text.trim().length>0:mode==='media'?attachment&&attachment.kind===mediaKind:mode==='template'?template:validateInteractivePayload(interactive).ok))
 const persist=(value:Attempt|null)=>{
  setAttempt(value)
  try{if(value)sessionStorage.setItem(key,JSON.stringify(value));else sessionStorage.removeItem(key)}catch{/* Optional storage; no content persisted */}
 }
 // Keep unrelated unsent text when the accepted action was a media,
 // template or interactive message. A pre-FIX-07 journal has no mode;
 // clear its text conservatively rather than offering an accidental resend.
 function finishAccepted(sentMode:Mode|undefined){
  const remainingText=sentMode&&sentMode!=='text'?text:''
  clearScopedDraft(draftKey)
  if(remainingText)saveScopedDraft(draftKey,{mode:'text',text:remainingText,caption:''})
  persist(null);setText(remainingText);setAttachment(null);setCaption('');setTemplate(null);setMode('text');onClearReply();onRefresh()
 }
 const buildPayload=():SendPayload=>{
  const quote=reply?.id??null
  if(mode==='media'&&attachment)return {messageType:attachment.kind,mediaUrl:attachment.url,filename:attachment.kind==='document'?attachment.filename:undefined,contentText:attachment.kind==='audio'?undefined:caption.trim()||undefined,replyToMessageId:quote}
  if(mode==='template'&&template)return {messageType:'template',templateName:template.name,templateLanguage:template.language,templateMessageParams:{body:template.body,headerText:template.headerText,buttonParams:template.buttonParams},replyToMessageId:quote}
  if(mode==='interactive')return {messageType:'interactive',interactivePayload:interactive,replyToMessageId:quote}
  return {messageType:'text',contentText:text.trim(),replyToMessageId:quote}
 }
 async function send(){
  if(!canSubmit||!scope||sendLock.current||uploadLock.current)return
  sendLock.current=true
  // This key is stored before the network boundary and is never
  // regenerated by a failed fetch, timeout, or component remount.
  const next:Attempt={key:crypto.randomUUID(),state:'pending',mode}
  persist(next);setBusy(true)
  try{
   const result=await submitScopedAction(ctx,{scope,key:next.key,action:'send',payload:buildPayload()})
   if(result.state==='accepted'){
    finishAccepted(next.mode)
   }else persist({...next,state:result.state,code:result.code})
  }catch{persist({...next,state:'uncertain',code:'admission_unconfirmed'})}
  finally{sendLock.current=false;setBusy(false)}
 }
 async function inspect(){
  if(!attempt||busy)return
  setBusy(true)
  try{
   const outcome=await inspectScopedAction(ctx,row.id,attempt.key)
   if(outcome.state==='accepted'){finishAccepted(attempt.mode)}
   else persist({...attempt,state:outcome.state,code:outcome.code})
  }catch{persist({...attempt,state:'uncertain',code:'admission_unconfirmed'})}
  finally{setBusy(false)}
 }
 async function stage(file:File|null,kind:Attachment['kind']=mediaKind){
  if(!file||!mounted.current||!canDraft||!enabled||expired||!c?.may_send_media||!c.media_kinds.includes(kind)||attempt||uploading||uploadLock.current||busy||sendLock.current||file.size===0||file.size>MEDIA_MAX_BYTES_BY_KIND[kind]){
   if(file&&file.size>MEDIA_MAX_BYTES_BY_KIND[kind])setFileError(t('actionFileTooLarge'))
   return
  }
  uploadLock.current=true;setUploading(true);setFileError(null)
  try{
   const result=await uploadAccountMedia('chat-media',file,ctx)
   // A late upload on a departed account must not repopulate its draft.
   // No provider request has been made, and no existing object is deleted.
   if(!mounted.current)return
   // The previous staged object has never crossed a provider boundary.
   if(attachment)void deleteAccountMedia('chat-media',attachment.path).catch(()=>{})
   setAttachment({kind,url:result.publicUrl,path:result.path,filename:file.name})
   setMediaKind(kind);setMode('media');setCaption('')
  }catch{if(mounted.current)setFileError(t('actionUploadFailed'))}
  finally{uploadLock.current=false;if(mounted.current)setUploading(false)}
 }
 async function discard(){
  if(!attachment||busy||attempt||uploadLock.current||recording||sendLock.current)return
  const previous=attachment
  setAttachment(null);setCaption('');setFileError(null)
  await deleteAccountMedia('chat-media',previous.path).catch(()=>{})
 }
 if(row.scope!=='active'||!row.channel_id)return null
 const isMeta=row.provider==='meta_cloud'
 const canAttach=Boolean(enabled&&c?.may_send_media&&!expired)
 return <section className="shrink-0 max-h-[min(55dvh,30rem)] space-y-2 overflow-y-auto overscroll-contain border-t border-border bg-card px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4" aria-label={t('actionTitle')}>
  <div className="flex flex-wrap items-center justify-between gap-2">
   <div className="flex min-w-0 items-center gap-2 text-xs font-medium"><ShieldCheck className="size-4 text-muted-foreground"/>{t('actionTitle')}</div>
   <label className="flex min-w-0 items-center gap-2 text-xs">
    <span className="shrink-0 text-muted-foreground">{t('actionChooseSender')}</span>
    <select className="min-h-11 min-w-0 max-w-52 rounded-lg border border-border bg-background px-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm" aria-label={t('actionChooseSender')}
     value={selectedConnection??''} disabled={Boolean(attempt)||busy||uploading||recording}
     onChange={e=>onSelectConnection(e.target.value||null)}>
     <option value="">{t('actionChooseSender')}</option>
     {connections.map(conn=><option key={conn.id} value={conn.id} disabled={!conn.ready||conn.archived}>
      {(conn.display_name||conn.id.slice(0,8))+' · '+(conn.is_primary?t('primary'):t('actionSecondary'))+' · '+(conn.ready?t('online'):t('offline'))}
     </option>)}
    </select>
   </label>
  </div>
  {!online&&<p role="status" aria-live="polite" className="text-xs text-destructive">{t('actionBrowserOffline')}</p>}
  {list.busy&&<p className="text-xs text-muted-foreground">{t('policyChecking')}</p>}
  {list.error&&<p role="alert" className="text-xs text-destructive">{t('policyUnavailable')}</p>}
  {!list.busy&&!list.error&&connections.length===0&&<p className="text-xs text-muted-foreground">{t('actionNoSender')}</p>}
  {selectedConnection&&!c&&<p role="status" className="text-xs text-muted-foreground">{t('policyChecking')}</p>}
  {c&&<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
   {isMeta&&<span className="rounded-full bg-muted px-2 py-1 tabular-nums">{windowInfo?.open?t('policyWindowOpen',{time:new Date(remaining).toISOString().slice(11,19)}):t('policyWindowClosed')}</span>}
   {c.blocked_reason&&<span role="status" className="rounded-md border border-border px-2 py-0.5">{t('policyDenied')}: {c.blocked_reason}</span>}
   {!c.dispatch_enabled&&<span>{t('actionDisabled')}</span>}
   {c.dispatch_enabled&&c.ready&&<span>{t('actionVerified')}</span>}
  </div>}
  {reply&&<ReplyQuote authorLabel={t('reply')+' · '+(reply.sender_type==='customer'?(row.contact.name||row.contact.phone):t('outgoing'))} preview={quotePreview(reply,t('replyNotLoaded'))} onDismiss={onClearReply}/>}
  <div role="group" aria-label={t('actionType')} className="flex flex-wrap items-center gap-1">
   <Button type="button" size="sm" variant={mode==='text'?'secondary':'ghost'} disabled={!canDraft||Boolean(attempt)||busy||uploading||recording||Boolean(attachment)} onClick={()=>setMode('text')}>{t('policyText')}</Button>
   <Button type="button" size="sm" variant={mode==='media'?'secondary':'ghost'} disabled={!canAttach||Boolean(attempt)||busy||uploading||recording} onClick={()=>setMode('media')} aria-label={t('policyMedia')}><Paperclip className="size-4"/>{t('policyMedia')}</Button>
   <Button type="button" size="sm" variant="ghost" disabled={!canDraft||Boolean(attempt)||busy||uploading||recording||Boolean(attachment)} aria-label={composerT('quickReplies')} onClick={()=>setQuickReplyPicker(true)}><Zap className="size-4"/></Button>
   {mode==='text'&&<Button type="button" size="sm" variant="ghost" disabled={!canDraft||Boolean(attempt)||busy} aria-label={t('actionEmoji')} aria-expanded={emojiOpen} onClick={()=>setEmojiOpen(v=>!v)}><Smile className="size-4"/></Button>}
   {isMeta&&<Button type="button" size="sm" variant={mode==='template'?'secondary':'ghost'} disabled={!enabled||!c?.may_send_template||Boolean(attempt)||busy||uploading||recording||Boolean(attachment)} onClick={()=>setTemplatePicker(true)}><LayoutTemplate className="size-4"/>{t('policyTemplate')}</Button>}
   {isMeta&&<Button type="button" size="sm" variant={mode==='interactive'?'secondary':'ghost'} disabled={!enabled||!c?.may_send_interactive||expired||Boolean(attempt)||busy||uploading||recording||Boolean(attachment)} onClick={()=>setMode('interactive')}>{t('policyInteractive')}</Button>}
  </div>
  {mode==='text'&&emojiOpen&&<div role="group" aria-label={t('actionEmoji')} className="flex flex-wrap gap-1">{['😀','😊','👍','❤️','🙏','🎉','✅','👋'].map(emoji=><Button type="button" key={emoji} size="sm" variant="ghost" disabled={!canDraft||Boolean(attempt)||busy} onClick={()=>{setText(v=>(v+emoji).slice(0,4096));setEmojiOpen(false);textarea.current?.focus()}}>{emoji}</Button>)}</div>}
  {mode==='text'&&<div className="flex items-end gap-2"><textarea ref={textarea} rows={2} maxLength={4096} value={text} onChange={e=>setText(e.target.value)} disabled={!canDraft||Boolean(attempt)||busy}
   onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&(e.ctrlKey||e.metaKey||window.matchMedia('(pointer:fine)').matches)){e.preventDefault();void send()}}}
   className="min-w-0 flex-1 resize-none rounded-2xl border border-border bg-background px-4 py-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
   placeholder={t('actionTextPlaceholder')} dir="auto" aria-label={t('actionTextPlaceholder')}/><Button type="button" onClick={()=>void send()} disabled={!canSubmit} aria-label={t('actionSend')} className="min-h-11 min-w-11 shrink-0 rounded-full px-3"><Send className="size-4 rtl:rotate-180"/></Button></div>}
  {mode==='media'&&<div className="flex flex-wrap items-center gap-2">
   <Paperclip className="size-4 text-muted-foreground"/>
   <select className="h-9 rounded-lg border border-border bg-background px-2 text-xs" aria-label={t('actionMediaKind')} value={mediaKind} disabled={Boolean(attempt)||uploading||busy||recording||Boolean(attachment)} onChange={e=>setMediaKind(e.target.value as Attachment['kind'])}>
    {(['image','video','document','audio'] as const).map(k=><option key={k} value={k} disabled={!c?.media_kinds.includes(k)}>{t('actionMedia_'+k)}</option>)}
   </select>
   <input type="file" className="min-h-11 min-w-0 flex-1 text-xs file:me-2 file:rounded-md file:border file:border-border file:bg-muted file:px-2 file:py-1" disabled={!canAttach||uploading||busy||recording||Boolean(attempt)}
    accept={mediaKind==='image'?'image/png,image/jpeg,image/webp':mediaKind==='video'?'video/mp4,video/3gpp':mediaKind==='audio'?'audio/ogg,audio/mpeg':'.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt'}
    aria-label={t('actionChooseFile')} onChange={e=>{void stage(e.currentTarget.files?.[0]??null);e.currentTarget.value=''}}/>
   <ScopedVoiceRecorder key={selectedConnection??'none'} disabled={!canAttach||!c?.media_kinds.includes('audio')||Boolean(attempt)||busy||Boolean(attachment)||(uploading&&!recording)} onBusyChange={setRecording} onFile={file=>stage(file,'audio')}/>
   {attachment&&<div className="w-full space-y-2 rounded-xl border border-border p-2">
    {attachment.kind==='image'&&<a href={attachment.url} target="_blank" rel="noopener noreferrer">{/* eslint-disable-next-line @next/next/no-img-element */}<img src={attachment.url} alt={attachment.filename} className="max-h-28 max-w-full rounded-lg object-contain"/></a>}
    {attachment.kind==='video'&&<video src={attachment.url} controls playsInline preload="none" className="max-h-28 max-w-full rounded-lg"/>}
    {attachment.kind==='audio'&&<audio src={attachment.url} controls preload="none" className="w-full"/>}
    <div className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate" dir="auto">{attachment.filename}</span><Button variant="ghost" size="sm" disabled={Boolean(attempt)||busy||uploading||recording} onClick={()=>void discard()} aria-label={t('actionRemoveFile')}><X className="size-4"/></Button></div>
   </div>}
   {attachment&&attachment.kind!=='audio'&&<input className="min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-base sm:text-sm" value={caption} disabled={Boolean(attempt)||busy||recording} maxLength={c?.caption_limit??1024} onChange={e=>setCaption(e.target.value)} placeholder={t('actionCaption')} aria-label={t('actionCaption')}/>}
  </div>}
  {fileError&&<p role="alert" className="text-xs text-destructive">{fileError}</p>}
  {mode==='template'&&isMeta&&<p className="text-xs text-muted-foreground" dir="auto">{template?template.name+' · '+template.language:t('actionSelectTemplate')}</p>}
  {mode==='interactive'&&isMeta&&<div className="max-h-44 overflow-y-auto rounded-lg border border-border p-2"><InteractiveBuilder value={interactive} onChange={setInteractive}/></div>}
  {attempt&&<div aria-live="polite" role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/60 px-3 py-2 text-xs">
   <AlertTriangle className="size-4 shrink-0 text-muted-foreground"/><span className="min-w-0 flex-1">{t('actionState_'+attempt.state)}{attempt.code?' · '+attempt.code:''}</span>
   <Button size="sm" variant="outline" disabled={busy} onClick={()=>void inspect()}><RefreshCw className="me-1 size-3.5"/>{t('actionCheckOutcome')}</Button>
   {attempt.state==='blocked'&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>persist(null)}>{t('actionNewAttempt')}</Button>}
  </div>}
  {containsUnsentDraft({mode,text,caption})&&!attempt&&<p role="status" className="text-xs text-muted-foreground">{t('actionDraftTabOnly')}</p>}
  <div className="flex items-center justify-between gap-2">
   <p className="max-w-[75%] text-[11px] text-muted-foreground">{!selectedConnection?t('actionSelectFirst'):c?.blocked_reason?t('policyDenied')+' · '+c.blocked_reason:!c?.dispatch_enabled?t('actionDisabled'):t('actionRecheck')}</p>
   {mode!=='text'&&<Button size="sm" onClick={()=>void send()} disabled={!canSubmit} className="min-h-11 min-w-11 gap-2"><Send className="size-4 rtl:rotate-180"/>{busy?t('loading'):t('actionSend')}</Button>}
  </div>
  <TemplatePicker open={templatePicker} onOpenChange={setTemplatePicker} onSelect={(selectedTemplate,values)=>{if(attachment||attempt||busy||recording||!enabled||!c?.may_send_template)return;setTemplate({name:selectedTemplate.name,language:selectedTemplate.language||'en_US',body:values.body,headerText:values.headerText,buttonParams:values.buttonParams});setMode('template')}}/>
  <QuickReplyPicker open={quickReplyPicker} onOpenChange={setQuickReplyPicker} onPick={qr=>{
   if(!canDraft||attachment||attempt||busy||recording)return
   if(qr.kind==='interactive'&&qr.interactive_payload&&isMeta&&enabled&&c?.may_send_interactive&&!expired){setInteractive(qr.interactive_payload);setMode('interactive')}
   else if(qr.content_text){setText(old=>((old.trim()?old+'\n':'')+qr.content_text).slice(0,4096));setMode('text')}
  }}/>
 </section>
}
