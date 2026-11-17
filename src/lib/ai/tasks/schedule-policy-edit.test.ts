import {describe,expect,it} from 'vitest'
import {parseSchedulePolicyEdit} from './schedule-admin'
describe('schedule edit contract',()=>{
 const now=Date.parse('2026-11-17T18:00:00Z')
 it('accepts only bounded pause-time edits',()=>{
  expect(parseSchedulePolicyEdit({expectedPolicyVersion:2,overlapPolicy:'defer',
    scheduleKind:'recurring',nextFireAt:'2026-11-19T00:00:00Z',
    intervalMinutes:60},now)).toMatchObject({expectedPolicyVersion:2,
    scheduleKind:'recurring',intervalMinutes:60,overlapPolicy:'defer'})
 })
 it('allows event overlap-only changes',()=>{
  expect(parseSchedulePolicyEdit({expectedPolicyVersion:1,overlapPolicy:'skip',
    scheduleKind:null,nextFireAt:null,intervalMinutes:null},now).nextFireAt).toBeNull()
 })
 it('rejects stale versions, invalid cadence and past dates',()=>{
  for (const input of [
    {expectedPolicyVersion:0,overlapPolicy:'skip',scheduleKind:null},
    {expectedPolicyVersion:1,overlapPolicy:'skip',scheduleKind:'once',nextFireAt:'2020-01-01'},
    {expectedPolicyVersion:1,overlapPolicy:'skip',scheduleKind:'recurring',
      nextFireAt:'2026-11-19T00:00:00Z',intervalMinutes:0},
  ]) expect(()=>parseSchedulePolicyEdit(input,now)).toThrow()
 })
})
