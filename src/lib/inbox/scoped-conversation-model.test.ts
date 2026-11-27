import {describe,expect,it} from 'vitest'
import {conversationDay,metaWindow,quotePreview,sameReplyLane} from './scoped-conversation-model'
import {deriveInboxCapabilities} from './provider-policy-model'
import type {HistoryMessage} from './scoped-history-model'
const policy={thread_id:'t',conversation_id:'p',channel_id:'c',connection_id:'s',membership_id:'m',ready:true,can_operate:true,recipient:'15550000123',contact_phone:'15550000123',server_now:'2026-11-27T12:00:00Z',last_inbound_at:'2026-11-27T11:00:00Z'}
describe('FIX-07 conversation presentation',()=>{
 it('never displays a Meta window on OpenWA',()=>{
  expect(metaWindow(deriveInboxCapabilities({...policy,provider:'openwa'}),0)).toBeNull()
  const meta=deriveInboxCapabilities({...policy,provider:'meta_cloud'})
  expect(metaWindow(meta,0)).toEqual({remaining:23*3600000,open:true})
  expect(metaWindow(meta,23*3600000)).toEqual({remaining:0,open:false})
  expect(metaWindow(deriveInboxCapabilities({...policy,provider:'meta_cloud',last_inbound_at:null}),0)?.open).toBe(false)
 })
 it('groups valid dates and bounds previews without requiring a send capability',()=>{
  expect(conversationDay(null,'ar')).toBeNull()
  expect(conversationDay('invalid','en')).toBeNull()
  expect(conversationDay(policy.server_now,'ko')).toBeTruthy()
  expect(quotePreview({content_text:null,content_type:'document'},'missing')).toBe('[document]')
  expect(quotePreview({content_text:'x'.repeat(500),content_type:'text'},'missing')).toHaveLength(240)
 })
 it('rejects a reply from any other conversation, channel or provider',()=>{
  const message={conversation_id:'p',channel_id:'c',provider:'openwa'} as HistoryMessage
  expect(sameReplyLane(message,'p','c','openwa')).toBe(true)
  expect(sameReplyLane(message,'p','other','openwa')).toBe(false)
  expect(sameReplyLane(message,'other','c','openwa')).toBe(false)
  expect(sameReplyLane(message,'p','c','meta_cloud')).toBe(false)
  expect(sameReplyLane(message,'p',null,'openwa')).toBe(false)
 })
})
