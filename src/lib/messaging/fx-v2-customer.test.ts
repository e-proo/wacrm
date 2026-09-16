import { describe, expect, it } from 'vitest'
import { renderFxTradeCustomerMessage } from './fx-v2-customer'
import type { TemplateOverrideStore } from './types'

const base = {
  accountId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  reference: 'FX-42',
  amountBasis: 'base' as const,
  requestedAmount: '1000',
  baseAmount: '1000',
  quoteAmount: '428000',
  baseCurrency: 'SAR',
  quoteCurrency: 'YER',
  rateVersionId: '33333333-3333-4333-8333-333333333333',
}

describe('renderFxTradeCustomerMessage', () => {
  it('renders customer_buy with the frozen business sell rate', async () => {
    const rendered = await renderFxTradeCustomerMessage({
      ...base,
      outcome: 'pending_admin',
      side: 'customer_buy',
      effectiveRate: '428',
    })

    expect(rendered.source).toBe('system')
    expect(rendered.eventKey).toBe('exchange_rate.trade.pending')
    expect(rendered.text).toContain('الزوج: SAR/YER')
    expect(rendered.text).toContain('العملية: شراء SAR')
    expect(rendered.text).toContain('المبلغ المطلوب: 1,000 SAR')
    expect(rendered.text).toContain('السعر الفعلي: 428 YER لكل SAR')
    expect(rendered.text).toContain('المبلغ الأساسي: 1,000 SAR')
    expect(rendered.text).toContain('المبلغ المقابل: 428,000 YER')
  })

  it('renders customer_sell with the frozen business buy rate', async () => {
    const rendered = await renderFxTradeCustomerMessage({
      ...base,
      outcome: 'rejected',
      side: 'customer_sell',
      effectiveRate: '425',
      quoteAmount: '425000',
    })

    expect(rendered.eventKey).toBe('exchange_rate.trade.rejected')
    expect(rendered.text).toContain('العملية: بيع SAR')
    expect(rendered.text).toContain('السعر الفعلي: 425 YER لكل SAR')
    expect(rendered.text).toContain('المبلغ المقابل: 425,000 YER')
  })

  it('keeps approved_for_contact distinct from completed', async () => {
    const approved = await renderFxTradeCustomerMessage({
      ...base,
      outcome: 'approved_for_contact',
      side: 'customer_buy',
      effectiveRate: '428',
    })
    const completed = await renderFxTradeCustomerMessage({
      ...base,
      outcome: 'completed',
      side: 'customer_buy',
      effectiveRate: '428',
    })

    expect(approved.eventKey).toBe('exchange_rate.trade.approved_for_contact')
    expect(approved.text).toContain('لم يُسجل كمكتمل بعد')
    expect(approved.text).not.toContain('تسجيلها كمكتملة')
    expect(completed.eventKey).toBe('exchange_rate.trade.completed')
    expect(completed.text).toContain('تسجيلها كمكتملة')
  })

  it('falls back to the system template when an override omits a financial fact', async () => {
    const store: TemplateOverrideStore = {
      async getPublishedTemplate(input) {
        if (input.key !== 'exchange_rate.trade.pending') return null
        return {
          revisionId: 'unsafe-fx-template',
          version: 9,
          key: input.key,
          audience: 'customer',
          channel: 'whatsapp',
          locale: 'ar',
          body: [
            '{{entity.reference}}',
            '{{data.pair}}',
            '{{data.side_label}}',
            '{{money.amount}} {{money.currency}}',
            // effective_rate intentionally omitted
            '{{data.base_amount}} {{data.base_currency}}',
            '{{data.quote_amount}} {{data.quote_currency}}',
          ].join('\n'),
        }
      },
    }

    const rendered = await renderFxTradeCustomerMessage({
      ...base,
      outcome: 'pending_admin',
      side: 'customer_buy',
      effectiveRate: '428',
      store,
    })

    expect(rendered.source).toBe('system')
    expect(rendered.fallbackReason).toBe('FX_TRADE_TEMPLATE_FINANCIAL_FACT_REQUIRED')
    expect(rendered.text).toContain('السعر الفعلي: 428 YER لكل SAR')
  })
})
