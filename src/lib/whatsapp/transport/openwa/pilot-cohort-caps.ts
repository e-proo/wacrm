/**
 * Read-only guidance for bounded OpenWA TEST Pilot approvals.
 * The server and SQL remain authoritative; suggestions never change a guardrail
 * or activate a session until the administrator saves explicitly.
 */
// TEST cap settings are limited only by the Postgres signed integer storage.
// Pilot admission, pacing, stop gates and Production policy still apply.
export const OPENWA_TEST_PILOT_MAX_HOURLY = 2_147_483_647
export const OPENWA_TEST_PILOT_MAX_DAILY = 2_147_483_647
export const OPENWA_TEST_PILOT_MAX_FIRST_TOUCH = 2_147_483_647
export const OPENWA_TEST_PILOT_MIN_INTERVAL_MS = 15_000
export const OPENWA_TEST_PILOT_DEFAULT_MESSAGES_PER_RECIPIENT = 3
export const OPENWA_TEST_PILOT_MAX_MESSAGES_PER_RECIPIENT = 100

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

/** Capacity is N selected contacts × M planned messages per contact.
 * First-touch admission remains N identities, not N×M messages.
 * This checks reserved capacity, NOT a guarantee of delivery to each contact.
 */
export function requiredPilotCohortMessages(count: number, messagesPerRecipient = OPENWA_TEST_PILOT_DEFAULT_MESSAGES_PER_RECIPIENT): number {
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('PILOT_COHORT_SIZE_INVALID')
  if (!Number.isInteger(messagesPerRecipient) || messagesPerRecipient < 1 ||
      messagesPerRecipient > OPENWA_TEST_PILOT_MAX_MESSAGES_PER_RECIPIENT) {
    throw new Error('PILOT_MESSAGES_PER_RECIPIENT_INVALID')
  }
  const total = count * messagesPerRecipient
  return total
}

export function missingPilotCohortCaps(
  caps: PilotCohortCapSnapshot,
  count: number,
  workload: PilotCohortWorkload,
  messagesPerRecipient = OPENWA_TEST_PILOT_DEFAULT_MESSAGES_PER_RECIPIENT,
): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 10) return ['recipient_count']
  if (!Number.isInteger(messagesPerRecipient) || messagesPerRecipient < 1 ||
      messagesPerRecipient > OPENWA_TEST_PILOT_MAX_MESSAGES_PER_RECIPIENT ||
      !Number.isSafeInteger(count * messagesPerRecipient)) {
    return ['messages_per_recipient']
  }
  const requiredMessages = count * messagesPerRecipient
  const required: Array<[string, number, number]> = [
    ['hourly_cap', caps.hourly_cap, requiredMessages],
    ['daily_cap', caps.daily_cap, requiredMessages],
    ['first_touch_daily_cap', caps.first_touch_daily_cap, count],
    ['warmup_hourly_cap', caps.warmup_hourly_cap ?? caps.hourly_cap, requiredMessages],
    ['warmup_daily_cap', caps.warmup_daily_cap ?? caps.daily_cap, requiredMessages],
    ['pilot_' + workload + '_hourly_cap',
      workload === 'agent'
        ? caps.pilot_agent_hourly_cap ?? caps.hourly_cap
        : caps.pilot_manual_hourly_cap ?? caps.hourly_cap, requiredMessages],
    ['pilot_' + workload + '_daily_cap',
      workload === 'agent'
        ? caps.pilot_agent_daily_cap ?? caps.daily_cap
        : caps.pilot_manual_daily_cap ?? caps.daily_cap, requiredMessages],
  ]
  return required.filter(([, value, min]) => !Number.isFinite(value) || value < min)
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
  messagesPerRecipient = OPENWA_TEST_PILOT_DEFAULT_MESSAGES_PER_RECIPIENT,
): {
  hourly_cap: number
  daily_cap: number
  first_touch_daily_cap: number
  pilot_agent_hourly_cap: number
  pilot_agent_daily_cap: number
  pilot_manual_hourly_cap: number
  pilot_manual_daily_cap: number
} {
  const requiredMessages = requiredPilotCohortMessages(count, messagesPerRecipient)
  const hourly = Math.max(caps.hourly_cap, requiredMessages)
  const daily = Math.max(caps.daily_cap, requiredMessages)
  const agentRequired = workload === 'agent' ? requiredMessages : 1
  const manualRequired = workload === 'manual' ? requiredMessages : 1
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
