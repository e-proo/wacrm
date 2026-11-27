import {afterEach,describe,it,expect,vi} from 'vitest'
import {createPolicyRefreshQueue,freshPolicy,policyScopeKey,POLICY_PREVIEW_MAX_AGE_MS} from './scoped-policy-refresh'
import type {InboxCapabilities} from './provider-policy-model'
afterEach(()=>vi.useRealTimers())
describe('stable scoped policy preview',()=>{
 const key=policyScopeKey('a','u','t','c','openwa','s','p',true)
 const snapshot={key,seen:1000,capabilities:{dispatch_enabled:true,may_send_text:true} as InboxCapabilities}
 it('retains a same-scope snapshot while background refresh is pending but never after expiry, disconnect or scope change',()=>{
  expect(freshPolicy(snapshot,key,2000,true)).toBe(snapshot)
  expect(freshPolicy(snapshot,key,1000+POLICY_PREVIEW_MAX_AGE_MS,true)).toBeNull()
  expect(freshPolicy(snapshot,key,2000,false)).toBeNull()
  for(const other of [
   policyScopeKey('other','u','t','c','openwa','s','p',true),
   policyScopeKey('a','other','t','c','openwa','s','p',true),
   policyScopeKey('a','u','other','c','openwa','s','p',true),
   policyScopeKey('a','u','t','other','openwa','s','p',true),
   policyScopeKey('a','u','t','c','meta_cloud','s','p',true),
   policyScopeKey('a','u','t','c','openwa','other','p',true),
   policyScopeKey('a','u','t','c','openwa','s','other',true)
  ])expect(freshPolicy(snapshot,other,2000,true)).toBeNull()
 })
 it('coalesces frequent revisions without cancelling an in-flight request or overlapping',async()=>{
  vi.useFakeTimers();vi.setSystemTime(0)
  let finish!:()=>void
  const load=vi.fn().mockImplementationOnce(()=>new Promise<void>(r=>finish=r)).mockResolvedValue(undefined)
  const q=createPolicyRefreshQueue(load)
  q.wake();q.wake();q.wake()
  expect(load).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(5000);q.wake();finish()
  await vi.advanceTimersByTimeAsync(4999)
  expect(load).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(load).toHaveBeenCalledTimes(2)
  q.dispose()
 })
 it('allows an explicit refresh immediately, and disposes queued old-scope work',async()=>{
  vi.useFakeTimers();vi.setSystemTime(0)
  const load=vi.fn().mockResolvedValue(undefined),q=createPolicyRefreshQueue(load)
  q.wake();await vi.advanceTimersByTimeAsync(0)
  q.wake();q.wake(true);await vi.advanceTimersByTimeAsync(0)
  expect(load).toHaveBeenCalledTimes(2)
  q.wake();q.dispose();await vi.advanceTimersByTimeAsync(20000)
  expect(load).toHaveBeenCalledTimes(2)
 })
})
