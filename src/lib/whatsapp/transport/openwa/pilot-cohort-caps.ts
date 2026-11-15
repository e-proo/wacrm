/**
 * Read-only guidance for bounded OpenWA TEST Pilot approvals.
 * The server and SQL remain authoritative; suggestions never change a guardrail
 * or activate a session until the administrator saves explicitly.
 */
// Editable ceilings apply ONLY to the explicitly controlled, pinned TEST Pilot.
// Production retains its independent guardrail settings and transport policy.
export const OPENWA_TEST_PILOT_MAX_HOURLY = 100
export const OPENWA_TEST_PILOT_MAX_DAILY = 1000
export const OPENWA_TEST_PILOT_MAX_FIRST_TOUCH = 10
export const OPENWA_TEST_PILOT_MIN_INTERVAL_MS = 15_000

export interface PilotCohortCapSnapshot {
  hourly_cap: number
  daily_cap: number
  first_touch_daily_cap: number
  warmup_hourly_cap?: number | null
  warmup_daily_cap?: number | null
  pilot_agent_hourly_cap?: number | null
  pilot_agent_daily_cap?: number | null
  pilot_manual_hourly_cap?: number | null
  pilot_manual_daily_cap?: number | null
}

export type PilotCohortWorkload = 'agent' | 'manual'

export function missingPilotCohortCaps(
  caps: PilotCohortCapSnapshot,
  count: number,
  workload: PilotCohortWorkload,
): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 10) return ['recipient_count']
  const required: Array<[string, number]> = [
    ['hourly_cap', caps.hourly_cap],
    ['daily_cap', caps.daily_cap],
    ['first_touch_daily_cap', caps.first_touch_daily_cap],
    ['warmup_hourly_cap', caps.warmup_hourly_cap ?? caps.hourly_cap],
    ['warmup_daily_cap', caps.warmup_daily_cap ?? caps.daily_cap],
    ['pilot_' + workload + '_hourly_cap',
      workload === 'agent'
        ? caps.pilot_agent_hourly_cap ?? caps.hourly_cap
        : caps.pilot_manual_hourly_cap ?? caps.hourly_cap],
    ['pilot_' + workload + '_daily_cap',
      workload === 'agent'
        ? caps.pilot_agent_daily_cap ?? caps.daily_cap
        : caps.pilot_manual_daily_cap ?? caps.daily_cap],
  ]
  return required.filter(([, value]) => !Number.isFinite(value) || value < count)
    .map(([key]) => key)
}

/**
 * Suggest the smallest shared-cap increase needed for the chosen number of
 * recipients, and clamp invalid per-workload caps to the shared ceiling.
 * Leaves pacing and jitter untouched. Warmup is aligned to shared caps by
 * the existing server-side "limits" action, not here.
 */
export function suggestedPilotCohortCaps(
  caps: PilotCohortCapSnapshot,
  count: number,
  workload: PilotCohortWorkload,
): {
  hourly_cap: number
  daily_cap: number
  first_touch_daily_cap: number
  pilot_agent_hourly_cap: number
  pilot_agent_daily_cap: number
  pilot_manual_hourly_cap: number
  pilot_manual_daily_cap: number
} {
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new Error('PILOT_COHORT_SIZE_INVALID')
  }
  const hourly = Math.max(caps.hourly_cap, count)
  const daily = Math.max(caps.daily_cap, count)
  const agentRequired = workload === 'agent' ? count : 1
  const manualRequired = workload === 'manual' ? count : 1
  return {
    hourly_cap: hourly,
    daily_cap: daily,
    first_touch_daily_cap: Math.max(caps.first_touch_daily_cap, count),
    pilot_agent_hourly_cap: Math.min(hourly,
      Math.max(agentRequired, caps.pilot_agent_hourly_cap ?? hourly)),
    pilot_agent_daily_cap: Math.min(daily,
      Math.max(agentRequired, caps.pilot_agent_daily_cap ?? daily)),
    pilot_manual_hourly_cap: Math.min(hourly,
      Math.max(manualRequired, caps.pilot_manual_hourly_cap ?? hourly)),
    pilot_manual_daily_cap: Math.min(daily,
      Math.max(manualRequired, caps.pilot_manual_daily_cap ?? daily)),
  }
}
