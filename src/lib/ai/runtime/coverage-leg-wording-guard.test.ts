import { describe, expect, it } from 'vitest'
import {
  guardCoverageLegWording,
  requiresFreshCoverageRates,
} from './coverage-leg-wording-guard'

describe('guardCoverageLegWording', () => {
  it('blocks the exact reversed Arabic wording case', () => {
    const result = guardCoverageLegWording(
      'coverage.get_rates',
      {
        pay_region: 'حضرموت',
        pay_method: 'cash',
        receive_region: 'صنعاء',
        receive_method: 'networks',
      },
      'اريد 100 الف سعودي تغطية نقد في حضرموت وسأسلم المبلغ تغطيه شبكات في صنعاء',
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('COVERAGE_LEG_WORDING_CONFLICT')
  })

  it('accepts the same wording when the explicit pay leg is mapped correctly', () => {
    expect(
      guardCoverageLegWording(
        'coverage.get_rates',
        {
          pay_region: 'صنعاء',
          pay_method: 'networks',
          receive_region: 'حضرموت',
          receive_method: 'cash',
        },
        'اريد 100 الف سعودي تغطية نقد في حضرموت وسأسلم المبلغ تغطيه شبكات في صنعاء',
      ),
    ).toEqual({ ok: true })
  })

  it('blocks UUID-only reversed legs using server-resolved region aliases', () => {
    const result = guardCoverageLegWording(
      'coverage.get_rates',
      {
        pay_region_id: '11111111-1111-1111-1111-111111111111',
        pay_method: 'cash',
        receive_region_id: '22222222-2222-2222-2222-222222222222',
        receive_method: 'networks',
      },
      'اريد 100 الف سعودي تغطية نقد في حضرموت وسأسلم المبلغ تغطيه شبكات في صنعاء',
      { pay: ['حضرموت'], receive: ['صنعاء'] },
    )

    expect(result.ok).toBe(false)
  })

  it('guards nested proposal attributes too', () => {
    const result = guardCoverageLegWording(
      'coverage.propose_offer',
      {
        attributes: {
          pay_region_id: '11111111-1111-1111-1111-111111111111',
          pay_method: 'cash',
          receive_region_id: '22222222-2222-2222-2222-222222222222',
          receive_method: 'networks',
        },
      },
      'اريد 100 الف سعودي تغطية نقد في حضرموت وسأسلم المبلغ تغطيه شبكات في صنعاء',
      { pay: ['حضرموت'], receive: ['صنعاء'] },
    )

    expect(result.ok).toBe(false)
  })

  it('blocks an explicit receive phrase mapped to the pay leg', () => {
    const result = guardCoverageLegWording(
      'coverage.find_offers',
      {
        pay_region: 'حضرموت',
        pay_method: 'cash',
        receive_region: 'صنعاء',
        receive_method: 'networks',
      },
      'سأدفع شبكات في صنعاء وسأستلم نقد في حضرموت',
    )

    expect(result.ok).toBe(false)
  })

  it('does not block ambiguous wording without an explicit pay/receive verb', () => {
    expect(
      guardCoverageLegWording(
        'coverage.get_rates',
        {
          pay_region: 'حضرموت',
          pay_method: 'cash',
          receive_region: 'صنعاء',
          receive_method: 'networks',
        },
        'اريد تغطية نقد حضرموت وشبكات صنعاء',
      ),
    ).toEqual({ ok: true })
  })

  it('does not affect unrelated tools', () => {
    expect(
      guardCoverageLegWording(
        'services.search',
        { pay_region: 'حضرموت', receive_region: 'صنعاء' },
        'سأسلم في صنعاء',
      ),
    ).toEqual({ ok: true })
  })
})

describe('requiresFreshCoverageRates', () => {
  it('requires a fresh authoritative read for the live reversed-wording example', () => {
    expect(
      requiresFreshCoverageRates(
        'اريد 100 الف سعودي تغطية نقد في حضرموت وسأسلم المبلغ تغطيه شبكات في صنعاء',
      ),
    ).toBe(true)
  })

  it('requires a fresh read when asking for a coverage rate', () => {
    expect(requiresFreshCoverageRates('كم نسبة التغطية اليوم؟')).toBe(true)
  })

  it('does not force a live rate tool for a generic explanation', () => {
    expect(requiresFreshCoverageRates('ما هي خدمة التغطية؟')).toBe(false)
  })
})
