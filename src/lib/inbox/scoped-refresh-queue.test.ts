import { describe,it,expect,vi,afterEach } from 'vitest'
import { createScopedRefreshQueue } from './scoped-refresh-queue'
afterEach(()=>vi.useRealTimers())
describe('scoped realtime invalidation queue',()=>{
 it('coalesces repeated and out-of-order events into one authoritative refresh',()=>{
  vi.useFakeTimers()
  const refresh=vi.fn(),queue=createScopedRefreshQueue(()=>true,refresh)
  queue.wake();queue.wake();queue.wake()
  vi.advanceTimersByTime(349);expect(refresh).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1);expect(refresh).toHaveBeenCalledTimes(1)
  queue.wake();vi.advanceTimersByTime(350);expect(refresh).toHaveBeenCalledTimes(2)
  queue.dispose()
 })
 it('ignores hidden tabs and resumes only when visible; scope disposal cancels old work',()=>{
  vi.useFakeTimers()
  let visible=false
  const refresh=vi.fn(),queue=createScopedRefreshQueue(()=>visible,refresh)
  queue.wake();vi.advanceTimersByTime(350);expect(refresh).not.toHaveBeenCalled()
  visible=true;queue.wake();visible=false;vi.advanceTimersByTime(350);expect(refresh).not.toHaveBeenCalled()
  visible=true;queue.wake();vi.advanceTimersByTime(350);expect(refresh).toHaveBeenCalledTimes(1)
  queue.wake();queue.dispose();vi.advanceTimersByTime(350);queue.wake();vi.advanceTimersByTime(350)
  expect(refresh).toHaveBeenCalledTimes(1)
 })
})
