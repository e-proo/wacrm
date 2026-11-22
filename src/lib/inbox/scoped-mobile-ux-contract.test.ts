import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import {parseLocation,selectionHref,selectExact,type ScopedRow} from './scoped-list-model'
import {scopedDraftKey,saveScopedDraft,getScopedDraft,clearAccountScopedDrafts} from './scoped-draft-memory'
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0')
const ctx={accountId:id(1),userId:id(2)}
const row=(scope:ScopedRow['scope'],number:number,channel:string|null):ScopedRow=>({
 id:id(number),conversation_id:id(11),channel_id:channel,provider:channel?'openwa':null,scope,
 read_only:true,route_ready:scope==='active',status:scope==='historical'?'closed':'open',
 preview:'a very long fictional fixture text '.repeat(6),last_message_at:'2026-11-21T10:00:00.000Z',
 unread_count_known:scope==='unknown'?null:1,contact:{id:id(10),name:'عميل تجريبي Test',phone:'15551230000',company:'TEST'},
})
const source=(path:string)=>readFileSync(process.cwd()+'/'+path,'utf8')
describe('SOF-86 mobile navigation safety fixtures',()=>{
 it('back returns to original lane and channel without switching provider or recipient',()=>{
  const active=row('active',3,id(4)),historical=row('historical',5,id(6)),unknown=row('unknown',11,null)
  for(const candidate of [active,historical,unknown]){
   const open=selectionHref(candidate.scope,candidate.channel_id,candidate)
   const loc=parseLocation(open.split('?')[1])
   expect(loc.scope).toBe(candidate.scope)
   expect(selectExact([active,historical,unknown],loc)).toEqual(candidate)
   const back=parseLocation(selectionHref(loc.scope,loc.channel).split('?')[1])
   expect(back.scope).toBe(candidate.scope)
   expect(back.channel).toBe(candidate.channel_id)
   expect(back.thread).toBeNull()
  }
  expect(selectExact([active,historical],parseLocation('scope=active&channel='+id(6)+'&thread='+id(3)))).toBeNull()
  expect(parseLocation('scope=active&thread='+id(3)+'&thread='+id(5)).invalid).toBe(true)
 })
 it('keeps same-channel drafts without persisting content or moving drafts between tenants',()=>{
  const key=scopedDraftKey(ctx,id(3),id(4))
  saveScopedDraft(key,{mode:'text',text:'Draft before switching sessions',caption:''},100)
  expect(getScopedDraft(key,101).text).toBe('Draft before switching sessions')
  expect(getScopedDraft(scopedDraftKey(ctx,id(3),id(6)),101).text).toBe('')
  expect(getScopedDraft(scopedDraftKey({accountId:id(9),userId:id(2)},id(3),id(4)),101).text).toBe('')
  clearAccountScopedDrafts(ctx)
 })
 it('keeps a focus-restoring single pane, labelled log, accessible drawer and a guarded composer',()=>{
  const workspace=source('src/components/inbox/scoped-inbox.tsx')
  const history=source('src/components/inbox/scoped-history-pane.tsx')
  const composer=source('src/components/inbox/scoped-action-pane.tsx')
  expect(workspace).toContain("getClientRects().length>0")
  expect(workspace).toContain("focus({preventScroll:true})")
  expect(workspace).toContain("SheetContent side={locale==='ar'?'left':'right'}")
  expect(workspace).toContain("hasSelection?'hidden lg:flex':'flex'")
  expect(history).toContain('role="log"')
  expect(history).toContain('aria-label={t(\'actionMessageHistory\')}')
  expect(history).toContain('min-h-11')
  expect(composer).toContain('env(safe-area-inset-bottom)')
  expect(composer).toContain('beforeunload')
  expect(composer).toContain('online&&c?.dispatch_enabled')
  expect(composer).not.toContain('localStorage.setItem')
 })
 it('has all mobile/offline/a11y labels translated in Arabic, English and Korean',()=>{
  const wanted=['actionDraftTabOnly','actionBrowserOffline','actionRealtimeReconnecting','actionThreadList','actionNoActiveChannels','actionMessageActions','actionMessageHistory']
  for(const lang of ['ar','en','ko']){
   const dict=JSON.parse(source('messages/'+lang+'.json')) as {Inbox:{scoped:Record<string,string>}}
   for(const key of wanted)expect(dict.Inbox.scoped[key],lang+':'+key).toBeTruthy()
  }
 })
})
