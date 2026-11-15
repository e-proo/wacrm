import { describe, expect, it } from 'vitest'
import { missingPilotCohortCaps, suggestedPilotCohortCaps } from './pilot-cohort-caps'

describe('OpenWA TEST bounded cohort capacity guidance', () => {
  const saved = {
    hourly_cap: 3, daily_cap: 10, first_touch_daily_cap: 1,
    warmup_hourly_cap: 3, warmup_daily_cap: 10,
    pilot_agent_hourly_cap: 10, pilot_agent_daily_cap: 30,
    pilot_manual_hourly_cap: 10, pilot_manual_daily_cap: 30,
  }

  it('pinpoints first-touch as the real 3-recipient admission shortage', () => {
    expect(missingPilotCohortCaps(saved, 3, 'agent')).toEqual(['first_touch_daily_cap'])
    expect(missingPilotCohortCaps(saved, 3, 'manual')).toEqual(['first_touch_daily_cap'])
  })

  it('suggests safely saved caps without raising shared caps unnecessarily', () => {
    const recommended = suggestedPilotCohortCaps(saved, 3, 'agent')
    expect(recommended).toEqual({
      hourly_cap: 3,
      daily_cap: 10,
      first_touch_daily_cap: 3,
      pilot_agent_hourly_cap: 3,
      pilot_agent_daily_cap: 10,
      pilot_manual_hourly_cap: 3,
      pilot_manual_daily_cap: 10,
    })
    expect(missingPilotCohortCaps({
      ...saved,
      ...recommended,
      warmup_hourly_cap: recommended.hourly_cap,
      warmup_daily_cap: recommended.daily_cap,
    }, 3, 'agent')).toEqual([])
  })

  it('raises a smaller shared session ceiling only as far as the cohort needs', () => {
    const suggested = suggestedPilotCohortCaps({
      hourly_cap: 2, daily_cap: 3, first_touch_daily_cap: 1,
      warmup_hourly_cap: 2, warmup_daily_cap: 3,
      pilot_agent_hourly_cap: 1, pilot_agent_daily_cap: 2,
      pilot_manual_hourly_cap: 2, pilot_manual_daily_cap: 3,
    }, 4, 'agent')
    expect(suggested).toMatchObject({
      hourly_cap: 4, daily_cap: 4, first_touch_daily_cap: 4,
      pilot_agent_hourly_cap: 4, pilot_agent_daily_cap: 4,
    })
    expect(suggested.pilot_manual_hourly_cap).toBeLessThanOrEqual(suggested.hourly_cap)
    expect(suggested.pilot_manual_daily_cap).toBeLessThanOrEqual(suggested.daily_cap)
  })

  it('does not create an unbounded or invalid 11+ recipient cap', () => {
    expect(missingPilotCohortCaps(saved, 11, 'agent')).toEqual(['recipient_count'])
    expect(() => suggestedPilotCohortCaps(saved, 11, 'agent')).toThrow('PILOT_COHORT_SIZE_INVALID')
    expect(() => suggestedPilotCohortCaps(saved, 0, 'manual')).toThrow('PILOT_COHORT_SIZE_INVALID')
  })

  it('still checks warmup and the selected workload, independent of the shared cap', () => {
    expect(missingPilotCohortCaps({
      ...saved,
      first_touch_daily_cap: 3, warmup_hourly_cap: 1,
      pilot_agent_hourly_cap: 2,
    }, 3, 'agent')).toEqual(['warmup_hourly_cap', 'pilot_agent_hourly_cap'])
    expect(missingPilotCohortCaps({
      ...saved,
      first_touch_daily_cap: 3,
      warmup_hourly_cap: 3,
    }, 3, 'manual')).toEqual([])
  })
})
