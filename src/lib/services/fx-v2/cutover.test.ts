import { describe, expect, it } from 'vitest'
import {
  FX_BUSINESS_EVENT_ROUTE_KEY,
  FX_BUSINESS_EVENT_TYPES,
} from './cutover'

describe('FX controlled business-event cutover contract', () => {
  it('uses one explicit account-scoped route key', () => {
    expect(FX_BUSINESS_EVENT_ROUTE_KEY).toBe('fx_trade_customer_whatsapp')
  })

  it('covers the complete canonical customer trade lifecycle', () => {
    expect(FX_BUSINESS_EVENT_TYPES).toEqual([
      'exchange_rate.trade.requested',
      'exchange_rate.trade.approved',
      'exchange_rate.trade.rejected',
      'exchange_rate.trade.completed',
    ])
  })
})
