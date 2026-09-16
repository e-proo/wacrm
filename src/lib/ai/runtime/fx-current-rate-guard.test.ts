import { describe, expect, it } from 'vitest'
import { requiresFreshFxRate } from './fx-current-rate-guard'

describe('requiresFreshFxRate', () => {
  it.each([
    'كم سعر صرف السعودي مقابل اليمني؟',
    'بكم الدولار اليوم؟',
    'أريد أشتري 1000 SAR باليمني',
    'What is the exchange rate for SAR to YER?',
    'What is the sell rate for USD/YER?',
  ])('requires an authoritative read for concrete FX language: %s', (text) => {
    expect(requiresFreshFxRate(text)).toBe(true)
  })

  it.each([
    'كم العمولة على تغطية 1000 SAR؟',
    'What is the coverage commission rate for SAR?',
    'أحتاج خدمة حوالة إلى صنعاء',
    'هل عندكم ريال سعودي؟',
    'Tell me about exchange rates generally',
  ])('does not over-classify non-current or non-FX pricing language: %s', (text) => {
    expect(requiresFreshFxRate(text)).toBe(false)
  })
})
