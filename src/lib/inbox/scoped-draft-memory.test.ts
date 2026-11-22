import {describe,it,expect,afterEach} from 'vitest'
import {scopedDraftKey,getScopedDraft,saveScopedDraft,clearScopedDraft,clearAccountScopedDrafts,containsUnsentDraft,emptyScopedDraft} from './scoped-draft-memory'
const ctx={accountId:'aa',userId:'user-one'},other={accountId:'bb',userId:'user-one'}
afterEach(()=>{clearAccountScopedDrafts(ctx);clearAccountScopedDrafts(other)})
describe('SOF-86 private in-memory draft boundary',()=>{
 it('retains text within the same channel/thread across a sender change, not other channels',()=>{
  const key=scopedDraftKey(ctx,'thread-one','channel-a')
  const v={mode:'text' as const,text:'Draft for this conversation',caption:''}
  saveScopedDraft(key,v,1000)
  expect(getScopedDraft(key,1010)).toEqual(v)
  expect(getScopedDraft(scopedDraftKey(ctx,'thread-one','channel-b'),1010)).toEqual(emptyScopedDraft())
  expect(getScopedDraft(scopedDraftKey(other,'thread-one','channel-a'),1010)).toEqual(emptyScopedDraft())
  expect(containsUnsentDraft(getScopedDraft(key,1010))).toBe(true)
  clearScopedDraft(key);expect(getScopedDraft(key,1020)).toEqual(emptyScopedDraft())
 })
 it('expires sensitive tab drafts and clears on account exit',()=>{
  const k=scopedDraftKey(ctx,'t','c')
  saveScopedDraft(k,{mode:'media',text:'private',caption:'caption'},1000)
  expect(getScopedDraft(k,1000+45*60*1000)).toEqual(emptyScopedDraft())
  saveScopedDraft(k,{mode:'text',text:'private',caption:''},2000000)
  clearAccountScopedDrafts(ctx)
  expect(getScopedDraft(k,2000010)).toEqual(emptyScopedDraft())
 })
 it('caps content and never records provider IDs, uploaded file URLs, or request keys',()=>{
  const k=scopedDraftKey(ctx,'t','c')
  saveScopedDraft(k,{mode:'text',text:'x'.repeat(4100),caption:'y'.repeat(1030)},1000)
  const d=getScopedDraft(k,1000)
  expect(d.text).toHaveLength(4096)
  expect(d.caption).toHaveLength(1024)
  expect(Object.keys(d).sort()).toEqual(['caption','mode','text'])
  expect(containsUnsentDraft({mode:'text',text:' ',caption:' '})).toBe(false)
 })
})
