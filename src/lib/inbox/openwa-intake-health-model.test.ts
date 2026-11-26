import {describe,expect,it} from 'vitest'
import {INTAKE_METRICS,INTAKE_LATENCY,normalizeIntakeHealth,normalizeIntakeReviewRow,normalizeIntakeHealthPage} from './openwa-intake-health-model'
const id='11111111-1111-4111-8111-111111111111',conn='22222222-2222-4222-8222-222222222222'
const health={...Object.fromEntries(INTAKE_METRICS.map(k=>[k,0])),latency_sample:Object.fromEntries(INTAKE_LATENCY.map(k=>[k,0]))}
const row={id,connection_id:conn,display_name:'fixture',state:'review',reason:'lease_expired',received_at:'2026-11-26T14:00:00Z',finished_at:'2026-11-26T14:01:00Z',closed_at:null,canonical:true}
describe('FIX-04 health projection',()=>{
 it('exposes only bounded nonsecret metrics and review metadata',()=>{
  expect(normalizeIntakeHealth({...health,private:'secret'})).toEqual(health)
  expect(normalizeIntakeReviewRow({...row,ciphertext:'secret',token:'secret'})).toEqual(row)
  expect(normalizeIntakeReviewRow({...row,reason:'secret'})).toBeNull()
  expect(normalizeIntakeHealth({...health,review_blocked:1})).toBeNull()
  expect(normalizeIntakeHealth({...health,retained_bytes:134217729})).toBeNull()
 })
 it('rejects inconsistent maintenance and case state',()=>{
  const page={read_only:true,health,items:[row],next_after:null,enabled:false,canonical:false,maintenance_ready:true}
  expect(normalizeIntakeHealthPage(page)).toEqual(page)
  expect(normalizeIntakeHealthPage({...page,enabled:true})).toBeNull()
  expect(normalizeIntakeHealthPage({...page,items:[row,row]})).toBeNull()
  expect(normalizeIntakeReviewRow({...row,state:'closed_unverified'})).toBeNull()
 })
})
