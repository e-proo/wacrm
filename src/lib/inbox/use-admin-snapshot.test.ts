import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import {adminSnapshotKeys,adminSnapshotView} from './use-admin-snapshot'

const ctx={accountId:'account-a',userId:'actor-a'}
const keys=adminSnapshotKeys(ctx,'intake-review?closed=false',1)
const page={items:[{id:'review-a'}]}
const snapshot={...keys,page,error:false}
describe('administrative snapshot refresh isolation',()=>{
 it('retains the same page during a manual refresh and replaces it on completion',()=>{
  const next=adminSnapshotKeys(ctx,'intake-review?closed=false',2)
  expect(adminSnapshotView(snapshot,next.scopeKey,next.requestKey,true)).toEqual({page,refreshing:true,error:false})
  const updated={items:[]}
  expect(adminSnapshotView({...next,page:updated,error:false},next.scopeKey,next.requestKey,true)).toEqual({page:updated,refreshing:false,error:false})
 })
 it('never exposes another actor, account, tab, or cursor snapshot',()=>{
  for(const other of [
   adminSnapshotKeys({...ctx,accountId:'account-b'},'intake-review?closed=false',1),
   adminSnapshotKeys({...ctx,userId:'actor-b'},'intake-review?closed=false',1),
   adminSnapshotKeys(ctx,'intake-review?closed=true',1),
   adminSnapshotKeys(ctx,'intake-review?closed=false&after=cursor',1),
  ])expect(adminSnapshotView(snapshot,other.scopeKey,other.requestKey,true)).toEqual({page:null,refreshing:true,error:false})
  expect(adminSnapshotView(snapshot,keys.scopeKey,keys.requestKey,false)).toEqual({page:null,refreshing:false,error:false})
 })
 it('fails closed on a denied or invalid refresh, not on ordinary polling',()=>{
  expect(adminSnapshotView({...keys,page:null,error:true},keys.scopeKey,keys.requestKey,true)).toEqual({page:null,refreshing:false,error:true})
 })
 it('isolates all three admin dialogs from workspace polling and retains stable row identity',()=>{
  const source=(path:string)=>readFileSync(process.cwd()+'/'+path,'utf8')
  const workspace=source('src/components/inbox/scoped-inbox.tsx')
  for(const [name,file] of [
   ['ScopedChannelReadiness','scoped-channel-readiness.tsx'],
   ['ScopedIntakeReview','scoped-intake-review.tsx'],
   ['ScopedOpenWAIntakeHealth','scoped-openwa-intake-health.tsx'],
  ]){
   const ui=source('src/components/inbox/'+file)
   expect(workspace).toContain('<'+name+' ctx={ctx} onChanged={onRetry}/>')
   expect(ui).toContain('useAdminSnapshot(ctx,open&&authorized,')
   expect(ui).not.toContain('revision:number')
   expect(ui).not.toContain("key={key+")
   expect(ui).toContain('disabled={refreshing} aria-busy={refreshing}')
   expect(ui).toContain('<fieldset disabled={refreshing}')
   expect(ui).toContain('onChanged()')
   expect(ui).toContain('confirmMaintenance:true')
  }
  expect(source('src/lib/inbox/use-admin-snapshot.ts')).toContain('return()=>ctl.abort()')
 })
})
