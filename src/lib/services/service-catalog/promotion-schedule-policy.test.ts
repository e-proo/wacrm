import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
 readFrozenPromotionSchedule, samePromotionAudience,
} from './promotion-schedule-policy'
import { promotionScheduledTaskIdentity } from './agent-task-service'

vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: vi.fn() }))

const a='11111111-1111-4111-8111-111111111111'
const service='22222222-2222-4222-8222-222222222222'
const agent='33333333-3333-4333-8333-333333333333'
const revision='44444444-4444-4444-8444-444444444444'
const actor='55555555-5555-4555-8555-555555555555'
const connection='66666666-6666-4666-8666-666666666666'
const contact='77777777-7777-4777-8777-777777777777'
const source='schedule:aaa:2026-11-18T00:00:00Z'
const now=Date.parse('2026-11-18T00:00:00Z')
const config=()=>({ promotionReview:{
 schemaVersion:1, serviceId:service, agentId:agent,
 approvedRevisionId:revision, approvedBy:actor,
 connectionId:connection, provider:'meta_cloud',
 fingerprint:'a'.repeat(64), reviewedAt:new Date(now-2000).toISOString(),
 approvedAt:new Date(now).toISOString(),
 frozenContactIds:[contact],
 consentAcknowledged:true,approvalAcknowledged:true,recurringAcknowledged:true,
}})
describe('SCH-3 immutable scheduled promotion policy',()=>{
 beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now)})
 afterEach(()=>vi.useRealTimers())
 it('accepts only the exact approved service, revision and actor',()=>{
  const c=config()
  expect(readFrozenPromotionSchedule(c,{serviceId:service,agentId:agent,
    approvedRevisionId:revision,createdBy:actor}).connectionId).toBe(connection)
  expect(()=>readFrozenPromotionSchedule(c,{serviceId:service,agentId:agent,
    approvedRevisionId:a,createdBy:actor})).toThrow()
  expect(()=>readFrozenPromotionSchedule(c,{serviceId:service,agentId:agent,
    approvedRevisionId:revision,createdBy:a})).toThrow()
 })
 it('rejects missing consent, duplicate recipients, and expired authorizations',()=>{
  const c=config()
  expect(()=>readFrozenPromotionSchedule({promotionReview:{
    ...c.promotionReview,consentAcknowledged:false,
  }},{serviceId:service,agentId:agent,approvedRevisionId:revision,createdBy:actor})).toThrow()
  expect(()=>readFrozenPromotionSchedule({promotionReview:{
    ...c.promotionReview,frozenContactIds:[contact,contact],
  }},{serviceId:service,agentId:agent,approvedRevisionId:revision,createdBy:actor})).toThrow()
  vi.setSystemTime(now+31*86400_000)
  expect(()=>readFrozenPromotionSchedule(c,{serviceId:service,agentId:agent,
    approvedRevisionId:revision,createdBy:actor})).toThrow('SERVICE_PROMOTION_SCHEDULE_APPROVAL_EXPIRED')
 })
 it('rejects cohort changes and keeps each source idempotent across retries',()=>{
  expect(samePromotionAudience([contact],[contact])).toBe(true)
  expect(samePromotionAudience([contact],[a])).toBe(false)
  const input={accountId:a,serviceId:service,agentId:agent,revisionId:revision,sourceKey:source}
  const key=promotionScheduledTaskIdentity(input)
  expect(key).toBe(promotionScheduledTaskIdentity(input))
  expect(key).not.toBe(promotionScheduledTaskIdentity({...input,sourceKey:source+':next'}))
  expect(key).not.toBe(promotionScheduledTaskIdentity({...input,accountId:contact}))
 })
})
