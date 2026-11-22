import {describe,it,expect} from 'vitest'
import {INBOX_HEALTH_KEYS,normalizeInboxHealth} from './health-model'
const good=Object.fromEntries(INBOX_HEALTH_KEYS.map(k=>[k,0]))
describe('scoped redacted Inbox health rollup',()=>{
 it('accepts only explicit non-PII counters and labels provisional thresholds',()=>{
  const r=normalizeInboxHealth({read_only:true,window:'24h',sampled_at:'2026-11-22T00:00:00Z',...good,action_uncertain:3,effect_claimed_over_5m:2,recent_orphan_memberships:1,access_token:'secret',native_message_id:'secret'})
  expect(r?.signals).toEqual({projection_mismatch:true,reconciliation_needed:true,backlog_attention:true})
  expect(r?.thresholds).toEqual({pending_minutes:5,orphan_count:0,uncertain_count:0})
  expect(JSON.stringify(r)).not.toContain('secret')
  expect(r?.counts.action_uncertain).toBe(3)
 })
 it('rejects incomplete and forged negative, float, nonnumeric counts',()=>{
  expect(normalizeInboxHealth({read_only:true,window:'24h',sampled_at:'2026-11-22T00:00:00Z'})).toBeNull()
  for(const n of [-1,1.5,'3',NaN,Number.MAX_SAFE_INTEGER+10]){
   expect(normalizeInboxHealth({read_only:true,window:'24h',sampled_at:'2026-11-22T00:00:00Z',...good,threads:n})).toBeNull()
  }
 })
})
