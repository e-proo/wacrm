import {describe,expect,it} from 'vitest'
import {normalizeReviewRow,normalizeReviewPage,reviewAction,type ReviewRow} from './intake-review-model'
const id='11111111-1111-4111-8111-111111111111',conn='22222222-2222-4222-8222-222222222222'
const row:ReviewRow={id,connection_id:conn,display_name:'fixture',reason:'namespace_unverified',created_at:'2026-11-26T14:00:00Z',resolved_at:null,decision:'unverified',outcome:null,preview:'held',message_kind:'text'}
describe('FIX-03 explicit review actions',()=>{
 it('permits only server-classified action and maintenance',()=>{
  expect(reviewAction(row,true)).toBe('close_unverified')
  expect(reviewAction({...row,decision:'restore'},true)).toBe('restore')
  expect(reviewAction({...row,decision:'duplicate'},true)).toBe('duplicate')
  expect(reviewAction({...row,decision:'busy'},true)).toBeNull()
  expect(reviewAction(row,false)).toBeNull()
  expect(reviewAction({...row,decision:'closed',resolved_at:row.created_at,outcome:'closed_unverified'},true)).toBeNull()
 })
 it('redacts private data and rejects malformed rows',()=>{
  expect(normalizeReviewRow({...row,native_id:'private',token:'secret',payload:{phone:'private'}})).toEqual(row)
  expect(normalizeReviewRow({...row,outcome:'closed_unverified'})).toBeNull()
  expect(normalizeReviewRow({...row,message_kind:'image'})).toBeNull()
  expect(normalizeReviewRow({...row,preview:'a'.repeat(161)})).toBeNull()
  expect(normalizeReviewPage({read_only:true,items:[row,row],next_after:null,maintenance_ready:true,closed:false})).toBeNull()
  expect(normalizeReviewPage({read_only:true,items:[row],next_after:conn,maintenance_ready:true,closed:false})).toBeNull()
  expect(normalizeReviewPage({read_only:true,items:[row],next_after:null,maintenance_ready:true,closed:true})).toBeNull()
 })
})
