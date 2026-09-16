import { describe, expect, it } from 'vitest'
import { guardCoverageLegWording } from './coverage-leg-wording-guard'

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
