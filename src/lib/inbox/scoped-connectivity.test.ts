import {describe,it,expect} from 'vitest'
import {scopedConnectivityNotice} from './scoped-connectivity'
describe('SOF-86 connectivity wording excludes WhatsApp readiness',()=>{
 it('distinguishes a browser outage from disconnected realtime',()=>{
  expect(scopedConnectivityNotice(false,'connected')).toBe('browser_offline')
  expect(scopedConnectivityNotice(false,'reconnecting')).toBe('browser_offline')
  expect(scopedConnectivityNotice(true,'reconnecting')).toBe('realtime_reconnecting')
  expect(scopedConnectivityNotice(true,'connecting')).toBeNull()
  expect(scopedConnectivityNotice(true,'connected')).toBeNull()
 })
})
