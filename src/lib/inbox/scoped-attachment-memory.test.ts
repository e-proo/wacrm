import {describe,expect,it,afterEach} from 'vitest'
import {scopedDraftKey} from './scoped-draft-memory'
import {getScopedAttachment,saveScopedAttachment,clearAccountScopedAttachments} from './scoped-attachment-memory'
const ctx={accountId:'a',userId:'u'}
const other={accountId:'b',userId:'u'}
const key=scopedDraftKey(ctx,'thread','channel')
const file={kind:'audio' as const,path:'account-a/voice.ogg',url:'https://example.test/voice.ogg',filename:'voice.ogg'}
afterEach(()=>{clearAccountScopedAttachments(ctx);clearAccountScopedAttachments(other)})
describe('FIX-07 volatile attachment lifecycle',()=>{
 it('restores a staged attachment only for the same actor, channel and thread',()=>{
  saveScopedAttachment(key,file,100)
  expect(getScopedAttachment(key,101)).toEqual(file)
  expect(getScopedAttachment(scopedDraftKey(ctx,'other','channel'),101)).toBeNull()
  expect(getScopedAttachment(scopedDraftKey(ctx,'thread','other'),101)).toBeNull()
  expect(getScopedAttachment(scopedDraftKey(other,'thread','channel'),101)).toBeNull()
  expect(getScopedAttachment(scopedDraftKey({...ctx,userId:'other'},'thread','channel'),101)).toBeNull()
 })
 it('refuses cross-account path and clears volatile data on expiry or logout',()=>{
  saveScopedAttachment(key,{...file,path:'account-b/voice.ogg'},100)
  expect(getScopedAttachment(key,101)).toBeNull()
  saveScopedAttachment(key,file,100)
  expect(getScopedAttachment(key,100+45*60*1000)).toBeNull()
  saveScopedAttachment(key,file,200)
  clearAccountScopedAttachments(ctx)
  expect(getScopedAttachment(key,201)).toBeNull()
 })
})
