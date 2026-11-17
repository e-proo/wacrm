import { describe, expect, it } from 'vitest'
import {
  missingPilotCohortCaps, suggestedPilotCohortCaps, requiredPilotCohortMessages,
  OPENWA_TEST_PILOT_DEFAULT_MESSAGES_PER_RECIPIENT,
  OPENWA_TEST_PILOT_MAX_HOURLY, OPENWA_TEST_PILOT_MAX_DAILY,
  OPENWA_TEST_PILOT_MAX_FIRST_TOUCH, OPENWA_TEST_PILOT_MIN_INTERVAL_MS,
} from './pilot-cohort-caps'

describe('OpenWA TEST bounded cohort capacity guidance', () => {
  const saved = {
    hourly_cap: 3, daily_cap: 10, first_touch_daily_cap: 1,
    warmup_hourly_cap: 3, warmup_daily_cap: 10,
    pilot_agent_hourly_cap: 10, pilot_agent_daily_cap: 30,
    pilot_manual_hourly_cap: 10, pilot_manual_daily_cap: 30,
  }

  it('retains TEST-only ceilings, default 3 messages per contact and minimum pacing', () => {
    expect(OPENWA_TEST_PILOT_MAX_HOURLY).toBe(2_147_483_647)
    expect(OPENWA_TEST_PILOT_MAX_DAILY).toBe(2_147_483_647)
    expect(OPENWA_TEST_PILOT_MAX_FIRST_TOUCH).toBe(2_147_483_647)
    expect(OPENWA_TEST_PILOT_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(15000)
    expect(OPENWA_TEST_PILOT_DEFAULT_MESSAGES_PER_RECIPIENT).toBe(3)
  })

  it('uses N × M for shared/workload/warmup, but first-touch is N identities', () => {
    expect(requiredPilotCohortMessages(3, 3)).toBe(9)
    expect(missingPilotCohortCaps({
      ...saved, first_touch_daily_cap: 3,
    }, 3, 'agent', 3)).toEqual([
      'hourly_cap', 'warmup_hourly_cap', 'pilot_agent_hourly_cap',
    ].filter((x) => x !== 'pilot_agent_hourly_cap'))
    expect(missingPilotCohortCaps({
      ...saved, first_touch_daily_cap: 3,
    }, 3, 'manual', 3)).toEqual(['hourly_cap', 'warmup_hourly_cap'])
    expect(missingPilotCohortCaps(saved, 3, 'agent', 3))
      .toEqual(['hourly_cap', 'first_touch_daily_cap', 'warmup_hourly_cap'])
  })

  it('suggests the minimum 9 messages for three contacts with 3 messages each', () => {
    const recommended = suggestedPilotCohortCaps(saved, 3, 'agent', 3)
    expect(recommended).toEqual({
      hourly_cap: 9, daily_cap: 10, first_touch_daily_cap: 3,
      pilot_agent_hourly_cap: 9, pilot_agent_daily_cap: 10,
      pilot_manual_hourly_cap: 9, pilot_manual_daily_cap: 10,
    })
    expect(missingPilotCohortCaps({
      ...saved, ...recommended,
      warmup_hourly_cap: recommended.hourly_cap,
      warmup_daily_cap: recommended.daily_cap,
    }, 3, 'agent', 3)).toEqual([])
  })

  it('preserves higher saved ceilings without artificially lowering 100/1000', () => {
    const large = {
      ...saved, hourly_cap: 100, daily_cap: 1000,
      warmup_hourly_cap: 100, warmup_daily_cap: 1000,
      pilot_agent_hourly_cap: 100, pilot_agent_daily_cap: 1000,
      first_touch_daily_cap: 3,
    }
    expect(missingPilotCohortCaps(large, 3, 'agent', 3)).toEqual([])
    const recommended = suggestedPilotCohortCaps(large, 3, 'agent', 3)
    expect(recommended).toMatchObject({
      hourly_cap: 100, daily_cap: 1000,
      pilot_agent_hourly_cap: 100, pilot_agent_daily_cap: 1000,
      first_touch_daily_cap: 3,
    })
  })

  it('supports flexible 2 recipients × 4 or 4 recipients × 3, not a fixed 3/10 quota', () => {
    expect(requiredPilotCohortMessages(2, 4)).toBe(8)
    expect(requiredPilotCohortMessages(4, 3)).toBe(12)
    const suggested = suggestedPilotCohortCaps({
      hourly_cap: 2, daily_cap: 3, first_touch_daily_cap: 1,
      warmup_hourly_cap: 2, warmup_daily_cap: 3,
      pilot_agent_hourly_cap: 1, pilot_agent_daily_cap: 2,
      pilot_manual_hourly_cap: 2, pilot_manual_daily_cap: 3,
    }, 4, 'agent', 3)
    expect(suggested).toMatchObject({
      hourly_cap: 12, daily_cap: 12, first_touch_daily_cap: 4,
      pilot_agent_hourly_cap: 12, pilot_agent_daily_cap: 12,
    })
    expect(suggested.pilot_manual_hourly_cap).toBeLessThanOrEqual(suggested.hourly_cap)
  })

  it('retains a one-message legacy cohort without retroactive new capacity', () => {
    expect(missingPilotCohortCaps({
      ...saved, first_touch_daily_cap: 3,
    }, 3, 'agent', 1)).toEqual([])
  })

  it('fails closed for invalid sizes and unsupportable per-contact counts', () => {
    expect(missingPilotCohortCaps(saved, 11, 'agent', 3)).toEqual(['recipient_count'])
    expect(missingPilotCohortCaps(saved, 10, 'agent', 101)).toEqual(['messages_per_recipient'])
    expect(() => requiredPilotCohortMessages(0, 3)).toThrow('PILOT_COHORT_SIZE_INVALID')
    expect(() => requiredPilotCohortMessages(3, 0)).toThrow('PILOT_MESSAGES_PER_RECIPIENT_INVALID')
    expect(() => suggestedPilotCohortCaps(saved, 10, 'agent', 101))
      .toThrow('PILOT_MESSAGES_PER_RECIPIENT_INVALID')
  })

  it('permits operator capacities above the old 100/1000 fixed ceilings', () => {
    expect(requiredPilotCohortMessages(10, 100)).toBe(1000)
    const higher = { ...saved, hourly_cap: 4000, daily_cap: 25000,
      warmup_hourly_cap: 4000, warmup_daily_cap: 25000,
      pilot_agent_hourly_cap: 4000, pilot_agent_daily_cap: 25000,
      first_touch_daily_cap: 100 }
    expect(missingPilotCohortCaps(higher, 10, 'agent', 100)).toEqual([])
  })
  it('still checks per-workload and warmup independently of shared cap', () => {
    const caps = {
      ...saved, hourly_cap: 20, daily_cap: 20,
      warmup_hourly_cap: 5, warmup_daily_cap: 20,
      pilot_agent_hourly_cap: 7, pilot_agent_daily_cap: 20,
      first_touch_daily_cap: 3,
    }
    expect(missingPilotCohortCaps(caps, 3, 'agent', 3))
      .toEqual(['warmup_hourly_cap', 'pilot_agent_hourly_cap'])
    expect(missingPilotCohortCaps({...caps, warmup_hourly_cap: 20},
      3, 'manual', 3)).toEqual([])
  })
})
