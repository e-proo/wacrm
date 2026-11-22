'use client'
import {useEffect,useState} from 'react'
import {useTranslations} from 'next-intl'
import {AlertTriangle,Paperclip,RefreshCw,Send,ShieldCheck,X} from 'lucide-react'
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
import type {HistoryMessage} from '@/lib/inbox/scoped-history-model'
import {scopedDraftKey,getScopedDraft,saveScopedDraft,clearScopedDraft,containsUnsentDraft} from '@/lib/inbox/scoped-draft-memory'
import {useBrowserOnline} from '@/lib/inbox/scoped-connectivity'

export type ActiveActionScope={scope:ActionScope;capabilities:InboxCapabilities}
type Mode='text'|'media'|'template'|'interactive'
type Attachment={kind:'image'|'video'|'audio'|'document';url:string;path:string;filename:string}
type TemplateDraft={name:string;language:string;body:string[];headerText?:string;buttonParams?:Record<number,string>}
type Attempt={key:string;state:ScopedActionOutcome['state'];code?:string}
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
  return v&&validId(v.key)&&['pending','uncertain','blocked','unconfirmed'].includes(v.state)?v:null
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
 const [mode,setMode]=useState<Mode>(()=>getScopedDraft(draftKey).mode)
 const [text,setText]=useState(()=>getScopedDraft(draftKey).text)
 const [attachment,setAttachment]=useState<Attachment|null>(null)
 const [mediaKind,setMediaKind]=useState<Attachment['kind']>('image')
 const [caption,setCaption]=useState(()=>getScopedDraft(draftKey).caption)
 const [fileError,setFileError]=useState<string|null>(null)
 const [template,setTemplate]=useState<TemplateDraft|null>(null)
 const [templatePicker,setTemplatePicker]=useState(false)
 const [quickReplyPicker,setQuickReplyPicker]=useState(false)
 const [interactive,setInteractive]=useState<InteractiveMessagePayload>(blankButtonsPayload)
 const [uploading,setUploading]=useState(false)
 const [busy,setBusy]=useState(false)
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
 const remaining=c?.window_expires_at&&active?Math.max(0,Date.parse(c.window_expires_at)-Date.parse(c.server_now)-(Math.max(tick,active.seen)-active.seen)):0
 const expired=c?.provider==='meta_cloud'&&c.window_expires_at!==null&&remaining<=0
 const scope:ActionScope|null=c&&validId(c.membership_id)&&selectedConnection&&row.channel_id?{
  threadId:row.id,channelId:row.channel_id,connectionId:selectedConnection,membershipId:c.membership_id,provider:c.provider
 }:null
 const enabled=Boolean(online&&c?.dispatch_enabled&&scope&&selected?.ready&&!selected.archived)
 const kindAllowed=mode==='text'?Boolean(c?.may_send_text&&!expired):mode==='media'?Boolean(c?.may_send_media&&!expired&&c.media_kinds.includes(mediaKind)):mode==='template'?Boolean(c?.may_send_template):Boolean(c?.may_send_interactive&&!expired)
 const replyAllowed=!reply||Boolean(c?.may_reply)
 const canSubmit=Boolean(enabled&&kindAllowed&&replyAllowed&&!busy&&!uploading&&!attempt&&(mode==='text'?text.trim().length>0:mode==='media'?attachment&&attachment.kind===mediaKind:mode==='template'?template:validateInteractivePayload(interactive).ok))
 const persist=(value:Attempt|null)=>{
  setAttempt(value)
  try{if(value)sessionStorage.setItem(key,JSON.stringify(value));else sessionStorage.removeItem(key)}catch{/* Optional storage; no content persisted */}
 }
 const buildPayload=():SendPayload=>{
  const quote=reply?.id??null
  if(mode==='media'&&attachment)return {messageType:attachment.kind,mediaUrl:attachment.url,filename:attachment.kind==='document'?attachment.filename:undefined,contentText:attachment.kind==='audio'?undefined:caption.trim()||undefined,replyToMessageId:quote}
  if(mode==='template'&&template)return {messageType:'template',templateName:template.name,templateLanguage:template.language,templateMessageParams:{body:template.body,headerText:template.headerText,buttonParams:template.buttonParams},replyToMessageId:quote}
  if(mode==='interactive')return {messageType:'interactive',interactivePayload:interactive,replyToMessageId:quote}
  return {messageType:'text',contentText:text.trim(),replyToMessageId:quote}
 }
 async function send(){
  if(!canSubmit||!scope)return
  // This key is stored before the network boundary and is never
  // regenerated by a failed fetch, timeout, or component remount.
  const next:Attempt={key:crypto.randomUUID(),state:'pending'}
  persist(next);setBusy(true)
  try{
   const result=await submitScopedAction(ctx,{scope,key:next.key,action:'send',payload:buildPayload()})
   if(result.state==='accepted'){
    persist(null);setText('');setAttachment(null);setCaption('');setTemplate(null);onClearReply();onRefresh()
   }else persist({key:next.key,state:result.state,code:result.code})
  }catch{persist({key:next.key,state:'uncertain',code:'admission_unconfirmed'})}
  finally{setBusy(false)}
 }
 async function inspect(){
  if(!attempt||busy)return
  setBusy(true)
  try{
   const outcome=await inspectScopedAction(ctx,row.id,attempt.key)
   if(outcome.state==='accepted'){clearScopedDraft(draftKey);persist(null);setMode('text');setText('');setCaption('');setAttachment(null);onClearReply();onRefresh()}
   else persist({...attempt,state:outcome.state,code:outcome.code})
  }catch{persist({...attempt,state:'uncertain',code:'admission_unconfirmed'})}
  finally{setBusy(false)}
 }
 async function stage(file:File|null){
  if(!file||!enabled||!c?.may_send_media||attempt||uploading||busy||file.size>MEDIA_MAX_BYTES_BY_KIND[mediaKind]){
   if(file&&file.size>MEDIA_MAX_BYTES_BY_KIND[mediaKind])setFileError(t('actionFileTooLarge'))
   return
  }
  setUploading(true);setFileError(null)
  try{
   const result=await uploadAccountMedia('chat-media',file)
   // The previous staged object has never crossed a provider boundary.
   if(attachment)void deleteAccountMedia('chat-media',attachment.path).catch(()=>{})
   setAttachment({kind:mediaKind,url:result.publicUrl,path:result.path,filename:file.name})
   setCaption('')
  }catch{setFileError(t('actionUploadFailed'))}
  finally{setUploading(false)}
 }
 async function discard(){
  if(!attachment||busy||attempt)return
  const previous=attachment
  setAttachment(null);setCaption('');setFileError(null)
  await deleteAccountMedia('chat-media',previous.path).catch(()=>{})
 }
 if(row.scope!=='active'||!row.channel_id)return null
 const isMeta=row.provider==='meta_cloud'
 const canAttach=Boolean(enabled&&c?.may_send_media)
 return <section className="shrink-0 max-h-[min(55dvh,30rem)] space-y-2 overflow-y-auto overscroll-contain border-t border-border bg-card px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4" aria-label={t('actionTitle')}>
  <div className="flex flex-wrap items-center justify-between gap-2">
   <div className="flex min-w-0 items-center gap-2 text-xs font-medium"><ShieldCheck className="size-4 text-muted-foreground"/>{t('actionTitle')}</div>
   <label className="flex min-w-0 items-center gap-2 text-xs">
    <span className="shrink-0 text-muted-foreground">{t('actionChooseSender')}</span>
    <select className="min-h-11 min-w-0 max-w-52 rounded-lg border border-border bg-background px-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm" aria-label={t('actionChooseSender')}
     value={selectedConnection??''} disabled={Boolean(attempt)||busy}
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
   <span>{c.provider==='openwa'?t('policyNoWindow'):c.window_state==='open'&&!expired?t('policyWindowOpen',{time:new Date(remaining).toISOString().slice(11,19)}):t('policyWindowClosed')}</span>
   {c.blocked_reason&&<span role="status" className="rounded-md border border-border px-2 py-0.5">{t('policyDenied')}: {c.blocked_reason}</span>}
   {!c.dispatch_enabled&&<span>{t('actionDisabled')}</span>}
   {c.dispatch_enabled&&c.ready&&<span>{t('actionVerified')}</span>}
  </div>}
  {reply&&<div className="flex items-center gap-2 rounded-md border-s-2 border-primary bg-muted/60 px-3 py-2 text-xs">
   <span className="min-w-0 flex-1 truncate" dir="auto">{t('reply')}: {reply.content_text||'['+reply.content_type+']'}</span>
   <Button size="sm" variant="ghost" onClick={onClearReply} aria-label={t('actionCancelReply')}><X className="size-3.5"/></Button>
  </div>}
  <div className="flex items-center gap-2">
   <label htmlFor={'inbox-mode-'+row.id} className="text-xs text-muted-foreground">{t('actionType')}</label>
   <select aria-label={t('actionType')} id={'inbox-mode-'+row.id} className="min-h-11 rounded-lg border border-border bg-background px-2 text-base sm:text-sm" value={mode} disabled={Boolean(attempt)||busy} onChange={e=>setMode(e.target.value as Mode)}>
    <option value="text">{t('policyText')}</option>
    <option value="media" disabled={!c?.may_send_media}>{t('policyMedia')}</option>
    {isMeta&&<option value="template" disabled={!c?.may_send_template}>{t('policyTemplate')}</option>}
    {isMeta&&<option value="interactive" disabled={!c?.may_send_interactive}>{t('policyInteractive')}</option>}
   </select>
   {mode==='text'&&<Button size="sm" variant="outline" disabled={!enabled||!c?.may_send_text||Boolean(attempt)} onClick={()=>setQuickReplyPicker(true)}>{t('actionQuickReply')}</Button>}
   {mode==='template'&&isMeta&&<Button size="sm" variant="outline" disabled={!c?.may_send_template||!c.dispatch_enabled||Boolean(attempt)} onClick={()=>setTemplatePicker(true)}>{t('actionSelectTemplate')}</Button>}
  </div>
  {mode==='text'&&<textarea rows={2} maxLength={4096} value={text} onChange={e=>setText(e.target.value)} disabled={!enabled||!c?.may_send_text||Boolean(attempt)}
   className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
   placeholder={t('actionTextPlaceholder')} dir="auto" aria-label={t('actionTextPlaceholder')}/>}
  {mode==='media'&&<div className="flex flex-wrap items-center gap-2">
   <Paperclip className="size-4 text-muted-foreground"/>
   <select className="h-9 rounded-lg border border-border bg-background px-2 text-xs" aria-label={t('actionMediaKind')} value={mediaKind} disabled={Boolean(attempt)||uploading||busy} onChange={e=>{if(attachment)void deleteAccountMedia('chat-media',attachment.path).catch(()=>{});setMediaKind(e.target.value as Attachment['kind']);setAttachment(null)}}>
    {(['image','video','document','audio'] as const).map(k=><option key={k} value={k} disabled={!c?.media_kinds.includes(k)}>{t('actionMedia_'+k)}</option>)}
   </select>
   <input type="file" className="min-h-11 min-w-0 flex-1 text-xs file:me-2 file:rounded-md file:border file:border-border file:bg-muted file:px-2 file:py-1" disabled={!canAttach||uploading||Boolean(attempt)}
    accept={mediaKind==='image'?'image/png,image/jpeg,image/webp':mediaKind==='video'?'video/mp4,video/3gpp':mediaKind==='audio'?'audio/ogg,audio/mpeg':'.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt'}
    aria-label={t('actionChooseFile')} onChange={e=>{void stage(e.currentTarget.files?.[0]??null);e.currentTarget.value=''}}/>
   {attachment&&<div className="flex w-full items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate">{attachment.filename}</span><Button variant="ghost" size="sm" disabled={Boolean(attempt)||busy} onClick={()=>void discard()}>{t('actionRemoveFile')}</Button></div>}
   {attachment&&attachment.kind!=='audio'&&<input className="min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-base sm:text-sm" value={caption} maxLength={c?.caption_limit??1024} onChange={e=>setCaption(e.target.value)} placeholder={t('actionCaption')} aria-label={t('actionCaption')}/>}
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
   <Button size="sm" onClick={()=>void send()} disabled={!canSubmit} className="min-h-11 min-w-11 gap-2"><Send className="size-4"/>{busy?t('loading'):t('actionSend')}</Button>
  </div>
  <TemplatePicker open={templatePicker} onOpenChange={setTemplatePicker} onSelect={(selectedTemplate,values)=>{setTemplate({name:selectedTemplate.name,language:selectedTemplate.language||'en_US',body:values.body,headerText:values.headerText,buttonParams:values.buttonParams});setMode('template')}}/>
  <QuickReplyPicker open={quickReplyPicker} onOpenChange={setQuickReplyPicker} onPick={qr=>{
   if(qr.kind==='interactive'&&qr.interactive_payload&&isMeta){setInteractive(qr.interactive_payload);setMode('interactive')}
   else if(qr.content_text){setText(old=>(old.trim()?old+'\n':'')+qr.content_text);setMode('text')}
  }}/>
 </section>
}
