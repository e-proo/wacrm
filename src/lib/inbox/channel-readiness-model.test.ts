import {describe,expect,it} from 'vitest'
import {normalizeReadinessRow,normalizeReadinessPage,readinessReasons,readinessCapabilities,type ReadinessRow} from './channel-readiness-model'
const id='11111111-1111-4111-8111-111111111111',member='22222222-2222-4222-8222-222222222222'
const row:ReadinessRow={id,provider:'openwa',display_name:'fixture',online:true,identity_verified:false,identity_candidate:true,channel_id:null,membership_id:null,
 identity_verified_at:null,last_closed_at:null,primary:false,credentials_present:true,signed_webhook_configured:true,engine:null,gateway_version:null,namespace_kind:'none',
 namespace_verified_at:null,namespace_contract_verified:false,handover_blocked:false,held_count_capped:2}
const gates={shadow:true,canonical:false,actions:false}
describe('FIX-02 readiness projection',()=>{
 it('does not conflate an online session or identity with canonical readiness',()=>{
  expect(readinessReasons(row)).toEqual(['readinessIdentityMissing','readinessNamespaceMissing','readinessPrimaryMissing'])
  expect(readinessCapabilities(row,gates)).toEqual({verifyIdentity:true,verifyPrimary:true,revoke:false})
  const verified={...row,identity_verified:true,channel_id:id,membership_id:member}
  expect(readinessReasons(verified)).toEqual(['readinessNamespaceMissing','readinessPrimaryMissing'])
  expect(readinessCapabilities({...verified,handover_blocked:true},gates).verifyPrimary).toBe(false)
  expect(readinessCapabilities(verified,{...gates,canonical:true}).revoke).toBe(false)
  expect(readinessCapabilities(verified,{...gates,actions:true}).revoke).toBe(false)
  expect(readinessCapabilities(verified,{...gates,shadow:false})).toEqual({verifyIdentity:false,verifyPrimary:false,revoke:false})
 })
 it('never applies OpenWA namespace conditions to Meta',()=>{
  const meta:ReadinessRow={...row,provider:'meta_cloud',credentials_present:null,signed_webhook_configured:null,identity_verified:true,channel_id:id,membership_id:member}
  expect(readinessReasons(meta)).toEqual([])
  expect(readinessCapabilities(meta,gates)).toEqual({verifyIdentity:false,verifyPrimary:false,revoke:false})
 })
 it('redacts extra data and rejects contradictory or malformed projections',()=>{
  expect(normalizeReadinessRow({...row,private_key:'secret',session_id:'private'})).toEqual(row)
  expect(normalizeReadinessRow({...row,primary:true})).toBeNull()
  expect(normalizeReadinessRow({...row,namespace_contract_verified:true})).toBeNull()
  expect(normalizeReadinessRow({...row,held_count_capped:102})).toBeNull()
  expect(normalizeReadinessPage({read_only:true,items:[row,row],next_after:null,gates})).toBeNull()
  expect(normalizeReadinessPage({read_only:true,items:[row],next_after:member,gates})).toBeNull()
  expect(normalizeReadinessPage({read_only:true,items:[row],next_after:id,gates})).not.toBeNull()
 })
})
