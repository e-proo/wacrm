/**
 * OW14-W04: read-only, redacted TEST Agent Task scheduler heartbeat evaluation.
 * A heartbeat confirms a successful DB-fenced worker tick, not which host
 * (Docker, Windows, or GitHub) invoked it. No tenant, JID or task data.
 */
export const SCHEDULER_DELAY_SECONDS = 90
export const SCHEDULER_STOP_SECONDS = 180

export type SchedulerPulseState = 'healthy' | 'delayed' | 'stopped' | 'missing' | 'unknown'
export type SchedulerPulseReason = 'recent' | 'late' | 'no_ticks' | 'failed_ticks' | 'clock_invalid' | 'no_success'

export interface SchedulerPulseInput {
  runnerLastSucceededAt?: unknown
  runnerLastStartedAt?: unknown
  runnerLastFinishedAt?: unknown
  runnerLastFailedAt?: unknown
  runnerLastResult?: unknown
  runnerConsecutiveFailures?: unknown
  runnerTickCount?: unknown
}

export interface SchedulerPulse {
  state: SchedulerPulseState
  reason: SchedulerPulseReason
  source: 'shared_test_database_heartbeat'
  lastSucceededAt: string | null
  lastStartedAt: string | null
  lastFailedAt: string | null
  consecutiveFailures: number
  tickCount: number
  secondsSinceSuccess: number | null
  delayAfterSeconds: number
  stopAfterSeconds: number
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}
function timeOrNull(value: unknown): string | null {
  return timestamp(value) === null ? null : value as string
}

/** A delayed or stopped result is an alert, not authorization to resend. */
export function evaluateSchedulerPulse(input: SchedulerPulseInput | null, nowMs = Date.now()): SchedulerPulse {
  const lastSuccess = timestamp(input?.runnerLastSucceededAt)
  const lastStarted = timestamp(input?.runnerLastStartedAt)
  const failures = count(input?.runnerConsecutiveFailures)
  const ticks = count(input?.runnerTickCount)
  const base: SchedulerPulse = {
    state: 'unknown', reason: 'no_success',
    source: 'shared_test_database_heartbeat',
    lastSucceededAt: timeOrNull(input?.runnerLastSucceededAt),
    lastStartedAt: timeOrNull(input?.runnerLastStartedAt),
    lastFailedAt: timeOrNull(input?.runnerLastFailedAt),
    consecutiveFailures: failures,
    tickCount: ticks,
    secondsSinceSuccess: null,
    delayAfterSeconds: SCHEDULER_DELAY_SECONDS,
    stopAfterSeconds: SCHEDULER_STOP_SECONDS,
  }
  if (!Number.isFinite(nowMs)) return {...base, state: 'unknown', reason: 'clock_invalid'}
  // Legacy/partial heartbeat projections may omit tick_count and started_at;
  // a valid success timestamp is still authoritative.
  if (!input || (ticks === 0 && lastStarted === null && lastSuccess === null)) {
    return {...base, state: 'missing', reason: 'no_ticks'}
  }
  if (lastSuccess === null) {
    if (lastStarted !== null && lastStarted > nowMs + 60_000)
      return {...base, state: 'unknown', reason: 'clock_invalid'}
    const age = lastStarted === null ? null : (nowMs - lastStarted) / 1000
    return age !== null && age > SCHEDULER_STOP_SECONDS
      ? {...base, state: 'stopped', reason: 'no_success'}
      : {...base, state: 'unknown', reason: 'no_success'}
  }
  if (lastSuccess > nowMs + 60_000) {
    return {...base, state: 'unknown', reason: 'clock_invalid'}
  }
  const ageSeconds = Math.max(0, Math.floor((nowMs - lastSuccess) / 1000))
  const pulse = {...base, secondsSinceSuccess: ageSeconds}
  if (ageSeconds >= SCHEDULER_STOP_SECONDS)
    return {...pulse, state: 'stopped' as const, reason: 'late' as const}
  if (ageSeconds >= SCHEDULER_DELAY_SECONDS)
    return {...pulse, state: 'delayed' as const, reason: 'late' as const}
  if (failures >= 2 || (failures > 0 && input.runnerLastResult === 'failed'))
    return {...pulse, state: 'delayed' as const, reason: 'failed_ticks' as const}
  return {...pulse, state: 'healthy' as const, reason: 'recent' as const}
}
