import { describe, expect, it } from 'vitest'
import { renderCoverageApprovedCustomerMessage } from '@/lib/messaging/coverage-customer'
import { renderServiceRequestCustomerMessage } from '@/lib/messaging/service-request-customer'
import { renderFxTradeCustomerMessage } from '@/lib/messaging/fx-v2-customer'
import { renderBusinessEventProjection } from './business-event-message-renderer'
import {
  EventProjectorRegistry,
  type BusinessEventProjectionInput,
} from './event-projector-registry'
import { buildCoverageApprovedBusinessEventProjection } from '@/lib/services/coverage/message-projectors'
import { buildFxTradeBusinessEventProjection } from '@/lib/services/fx-v2/message-projectors'
import { buildGenericServiceRequestProjection } from './generic-message-projectors'

describe('EventProjectorRegistry', () => {
  const input: BusinessEventProjectionInput = {
    accountId: 'acc-1',
    eventType: 'testing.item.updated',
    eventVersion: 1,
    subjectType: 'test_item',
    subjectId: 'item-1',
    audience: 'internal',
    channel: 'in_app',
    correlationId: null,
    causationId: null,
    payload: {},
  }

  it('dispatches exact event versions and rejects duplicates', async () => {
    const registry = new EventProjectorRegistry()
    registry.register({
      eventType: input.eventType,
      eventVersion: 1,
      projector: async () => ({
        eventKey: input.eventType,
        audience: 'internal',
        channel: 'in_app',
        locale: 'ar',
        context: { entity: { type: 'test_item', id: 'item-1' }, data: {} },
      }),
    })

    await expect(registry.project(input)).resolves.toMatchObject({
      eventKey: 'testing.item.updated',
      audience: 'internal',
      channel: 'in_app',
    })

    expect(() =>
      registry.register({
        eventType: input.eventType,
        eventVersion: 1,
        projector: async () => {
          throw new Error('unreachable')
        },
      }),
    ).toThrow('Duplicate event projector')

    await expect(
      registry.project({ ...input, eventVersion: 2 }),
    ).rejects.toThrow('EVENT_PROJECTOR_NOT_REGISTERED')
  })

  it('fails closed when a projector changes event or delivery surface', async () => {
    const registry = new EventProjectorRegistry().register({
      eventType: input.eventType,
      eventVersion: 1,
      projector: async () => ({
        eventKey: 'testing.item.other',
        audience: 'internal',
        channel: 'in_app',
        locale: 'ar',
        context: { entity: { type: 'test_item' }, data: {} },
      }),
    })

    await expect(registry.project(input)).rejects.toThrow(
      'EVENT_PROJECTOR_KEY_MISMATCH',
    )
  })
})

describe('domain message projectors', () => {
  it('projects Coverage from the embedded event snapshot and uses authoritative commission_amount', async () => {
    const projection = buildCoverageApprovedBusinessEventProjection({
      accountId: 'acc-1',
      eventType: 'coverage.offer.approved',
      eventVersion: 1,
      subjectType: 'coverage_offer',
      subjectId: 'offer-1',
      audience: 'customer',
      channel: 'whatsapp',
      correlationId: 'cr-1',
      causationId: 'intent-1',
      payload: {
        service_id: 'service-1',
        reference: 'COV-1',
        amount: '100000',
        currency: 'SAR',
        attributes: {
          coverage_scope: 'domestic',
          coverage_country: null,
          pay_region_id: '11111111-1111-4111-8111-111111111111',
          pay_method: 'cash',
          receive_region_id: '22222222-2222-4222-8222-222222222222',
          receive_method: 'networks',
        },
        pay_region_label: 'حضرموت',
        receive_region_label: 'صنعاء',
        commission_per_thousand: '9999',
        commission_amount: '701.2345',
        commission_currency: 'SAR',
      },
    })

    expect(projection.context.money?.commission).toBe('701.2345')
    expect(projection.context.data.pay_region).toBe('حضرموت')
    expect(projection.context.data.receive_region).toBe('صنعاء')

    const projected = await renderBusinessEventProjection({
      accountId: 'acc-1',
      projection,
    })
    const legacyRenderer = await renderCoverageApprovedCustomerMessage({
      accountId: 'acc-1',
      kind: 'offer',
      entityId: 'offer-1',
      reference: 'COV-1',
      serviceId: 'service-1',
      amount: '100000',
      currency: 'SAR',
      payRegion: 'حضرموت',
      payMethod: 'cash',
      receiveRegion: 'صنعاء',
      receiveMethod: 'networks',
      commissionAmount: '701.2345',
      commissionCurrency: 'SAR',
    })

    expect(projected.text).toBe(legacyRenderer.text)
    expect(projected.text).toContain('الراجع لك: 701.2345 SAR')
    expect(projected.text).not.toContain('الراجع لك: 700 SAR')
  })

  it('projects FX from immutable subject facts with rendering parity', async () => {
    const facts = {
      id: 'trade-1',
      code: '42',
      side: 'customer_buy' as const,
      amountBasis: 'base' as const,
      requestedAmount: '1000',
      effectiveRate: '428',
      baseAmount: '1000',
      quoteAmount: '428000',
      rateVersionId: 'rate-version-1',
      baseCurrency: 'SAR',
      quoteCurrency: 'YER',
    }
    const projection = buildFxTradeBusinessEventProjection({
      eventType: 'exchange_rate.trade.requested',
      subjectType: 'fx_trade_request',
      subjectId: 'trade-1',
      facts,
    })

    const projected = await renderBusinessEventProjection({
      accountId: 'acc-1',
      projection,
    })
    const legacyRenderer = await renderFxTradeCustomerMessage({
      accountId: 'acc-1',
      outcome: 'pending_admin',
      requestId: facts.id,
      reference: 'FX-42',
      side: facts.side,
      amountBasis: facts.amountBasis,
      requestedAmount: facts.requestedAmount,
      effectiveRate: facts.effectiveRate,
      baseAmount: facts.baseAmount,
      quoteAmount: facts.quoteAmount,
      baseCurrency: facts.baseCurrency,
      quoteCurrency: facts.quoteCurrency,
      rateVersionId: facts.rateVersionId,
    })

    expect(projected.text).toBe(legacyRenderer.text)
  })

  it('projects generic service requests from the embedded snapshot with legacy rendering parity', async () => {
    const matched = buildGenericServiceRequestProjection({
      accountId: 'acc-1',
      eventType: 'service_request.matched',
      eventVersion: 1,
      subjectType: 'service_intent',
      subjectId: 'intent-1',
      audience: 'customer',
      channel: 'whatsapp',
      correlationId: 'cr-1',
      causationId: 'intent-1',
      payload: {
        decision: 'matched',
        service_id: 'service-1',
        service_name: 'خدمة تجريبية',
      },
    })
    const projectedMatched = await renderBusinessEventProjection({
      accountId: 'acc-1',
      projection: matched,
    })
    const legacyMatched = await renderServiceRequestCustomerMessage({
      accountId: 'acc-1',
      outcome: 'matched',
      entityId: 'intent-1',
      serviceId: 'service-1',
      serviceName: 'خدمة تجريبية',
    })
    expect(projectedMatched.text).toBe(legacyMatched.text)

    const rejected = buildGenericServiceRequestProjection({
      accountId: 'acc-1',
      eventType: 'service_request.rejected',
      eventVersion: 1,
      subjectType: 'service_intent',
      subjectId: 'intent-2',
      audience: 'customer',
      channel: 'whatsapp',
      correlationId: 'cr-2',
      causationId: 'intent-2',
      payload: {
        decision: 'rejected',
        customer_reason: 'البيانات غير مكتملة',
      },
    })
    const projectedRejected = await renderBusinessEventProjection({
      accountId: 'acc-1',
      projection: rejected,
    })
    const legacyRejected = await renderServiceRequestCustomerMessage({
      accountId: 'acc-1',
      outcome: 'rejected',
      entityId: 'intent-2',
      customerReason: 'البيانات غير مكتملة',
    })
    expect(projectedRejected.text).toBe(legacyRejected.text)
  })
})
