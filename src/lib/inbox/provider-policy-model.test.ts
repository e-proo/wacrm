import { describe,it,expect } from 'vitest'
import { deriveInboxCapabilities,allowsContent,type PolicyContext,type PolicyReason,WINDOW_MS } from './provider-policy-model'
const now=Date.parse('2026-11-22T01:00:00Z')
const context:PolicyContext={thread_id:'thread',conversation_id:'parent',channel_id:'channel',provider:'meta_cloud',connection_id:'connection',membership_id:'epoch',ready:true,can_operate:true,recipient:'15551234567',contact_phone:'15551234567',last_inbound_at:new Date(now-1000).toISOString(),server_now:new Date(now).toISOString()}
describe('SOF-78 provider capability contract',()=>{
 it('opens Meta freeform only strictly before the exact trusted 24h boundary',()=>{
  const at=(offset:number)=>deriveInboxCapabilities({...context,last_inbound_at:new Date(now-offset).toISOString()})
  expect(at(WINDOW_MS-1)).toMatchObject({window_state:'open',may_send_text:true,may_send_media:true,may_send_interactive:true})
  for(const offset of [WINDOW_MS,WINDOW_MS+1])expect(at(offset)).toMatchObject({window_state:'closed',may_send_text:false,may_send_media:false,may_send_interactive:false,may_send_template:true,blocked_reason:'meta_window_closed'})
 })
 it('fails closed on missing, invalid, future or wrong-provider evidence',()=>{
  for(const value of [null,'invalid',new Date(now+1).toISOString()])expect(deriveInboxCapabilities({...context,last_inbound_at:value})).toMatchObject({window_state:'closed',may_send_text:false,window_expires_at:null})
  expect(deriveInboxCapabilities({...context,provider:'openwa'})).toMatchObject({window_state:'not_applicable',last_inbound_at:null,window_expires_at:null})
 })
 it('OpenWA has no Meta window and no Meta-only controls',()=>{
  for(const last_inbound_at of [null,new Date(now-30*WINDOW_MS).toISOString()]){
   const c=deriveInboxCapabilities({...context,provider:'openwa',last_inbound_at})
   expect(c).toMatchObject({may_send_text:true,may_send_media:true,may_send_template:false,may_send_interactive:false,may_react:false,window_state:'not_applicable',dispatch_enabled:false})
   expect(allowsContent(c,'template')).toBe(false)
   expect(allowsContent(c,'image')).toBe(true)
  }
 })
 it('fails closed for role, recipient, readiness, no selected sender and all policy stops',()=>{
  for(const input of [{can_operate:false},{ready:false},{recipient:null},{membership_id:null},{connection_id:null}]){
   const p=deriveInboxCapabilities({...context,...input})
   expect(p.may_send_text||p.may_send_template||p.may_send_media||p.may_read).toBe(false)
  }
  const reasons:PolicyReason[]=['manual_pause','operational_denied','failure_circuit_open','pilot_recipient_not_allowlisted','daily_cap','hourly_cap','first_touch_daily_cap','channel_hourly_cap','channel_daily_cap','channel_first_touch_cap','policy_unavailable']
  for(const r of reasons)expect(deriveInboxCapabilities({...context,provider:'openwa'},r)).toMatchObject({blocked_reason:r,may_send_text:false,may_send_media:false,may_send_template:false})
 })
})
