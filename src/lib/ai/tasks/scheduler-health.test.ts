import { describe, expect, it } from 'vitest'
import { evaluateSchedulerPulse, SCHEDULER_DELAY_SECONDS, SCHEDULER_STOP_SECONDS } from './scheduler-health'

const now = Date.parse('2026-11-20T00:00:00.000Z')
const row = (ageSeconds: number, overrides: Record<string, unknown> = {}) => ({
  runnerLastSucceededAt: new Date(now - ageSeconds * 1000).toISOString(),
  runnerLastStartedAt: new Date(now - ageSeconds * 1000).toISOString(),
  runnerLastResult: 'success', runnerConsecutiveFailures: 0, runnerTickCount: 1640,
  ...overrides,
})

describe('OW14-W04 worker heartbeat classification', () => {
  it('reflects actual successful database ticks, not NODE_ENV or npm dev', () => {
    const result = evaluateSchedulerPulse(row(7), now)
    expect(result).toMatchObject({
      state: 'healthy', secondsSinceSuccess: 7, consecutiveFailures: 0,
      source: 'shared_test_database_heartbeat', tickCount: 1640,
    })
  })
  it('alerts at configured delay and stop boundaries without calling the worker', () => {
    expect(evaluateSchedulerPulse(row(SCHEDULER_DELAY_SECONDS - 1), now).state).toBe('healthy')
    expect(evaluateSchedulerPulse(row(SCHEDULER_DELAY_SECONDS), now).state).toBe('delayed')
    expect(evaluateSchedulerPulse(row(SCHEDULER_STOP_SECONDS), now).state).toBe('stopped')
    expect(evaluateSchedulerPulse(row(99999), now).state).toBe('stopped')
    expect(evaluateSchedulerPulse({runnerLastSucceededAt:new Date(now-600000).toISOString()},now).state).toBe('stopped')
  })
  it('warns on failed ticks even with recent success', () => {
    expect(evaluateSchedulerPulse(row(5, {runnerLastResult:'failed',runnerConsecutiveFailures:1}), now))
      .toMatchObject({state:'delayed',reason:'failed_ticks'})
    expect(evaluateSchedulerPulse(row(5, {runnerLastResult:'success',runnerConsecutiveFailures:2}), now))
      .toMatchObject({state:'delayed',reason:'failed_ticks'})
  })
  it('fails visibly on no heartbeat, no success, malformed or future timestamps', () => {
    expect(evaluateSchedulerPulse(null, now).state).toBe('missing')
    expect(evaluateSchedulerPulse({runnerTickCount:1,runnerLastStartedAt:new Date(now-300000).toISOString()},now).state).toBe('stopped')
    expect(evaluateSchedulerPulse({runnerTickCount:1,runnerLastStartedAt:new Date(now-10000).toISOString()},now).state).toBe('unknown')
    expect(evaluateSchedulerPulse(row(1,{runnerLastSucceededAt:'malformed'}),now).state).toBe('unknown')
    expect(evaluateSchedulerPulse(row(-120),now).state).toBe('unknown')
  })
  it('sanitizes counts and never returns arbitrary raw database error text', () => {
    const x = evaluateSchedulerPulse(row(10, {runnerConsecutiveFailures:-5,runnerTickCount:'not-a-number'}),now)
    expect(x.consecutiveFailures).toBe(0)
    expect(x.tickCount).toBe(0)
    expect(Object.keys(x)).not.toContain('message')
  })
})
