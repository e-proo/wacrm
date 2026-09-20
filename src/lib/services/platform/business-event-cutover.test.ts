import { describe, expect, it } from 'vitest'
import { evaluateBusinessEventCutoverReadiness } from './business-event-cutover'

describe('business event cutover readiness gate', () => {
  it('requires durable matched-legacy evidence before reporting ready', () => {
    const ready = evaluateBusinessEventCutoverReadiness({
      activeRows: 0,
      evidence: [
        {
          event_type: 'exchange_rate.trade.requested',
          event_version: 1,
          shadow_projection_status: 'matched_legacy',
          legacy_notification_id: 'legacy-1',
        },
        {
          event_type: 'coverage.offer.approved',
          event_version: 1,
          shadow_projection_status: 'matched_legacy',
          legacy_notification_id: 'legacy-2',
        },
      ],
    })

    expect(ready.ready).toBe(true)
    expect(ready.matchedLegacy).toBe(2)
    expect(ready.blockers).toBe(0)
  })

  it('fails closed for empty evidence, mismatches, native-only customer sends, or active rows', () => {
    const empty = evaluateBusinessEventCutoverReadiness({
      activeRows: 0,
      evidence: [],
    })
    expect(empty.ready).toBe(false)
    expect(empty.reasons).toContain('NO_CUSTOMER_WHATSAPP_SHADOW_EVIDENCE')

    const blocked = evaluateBusinessEventCutoverReadiness({
      activeRows: 1,
      evidence: [
        {
          event_type: 'coverage.offer.approved',
          event_version: 1,
          shadow_projection_status: 'mismatched_legacy',
          legacy_notification_id: 'legacy-1',
        },
        {
          event_type: 'coverage.request.approved',
          event_version: 1,
          shadow_projection_status: 'native_only',
          legacy_notification_id: null,
        },
      ],
    })

    expect(blocked.ready).toBe(false)
    expect(blocked.blockers).toBe(2)
    expect(blocked.reasons).toEqual(
      expect.arrayContaining([
        'ACTIVE_BUSINESS_EVENT_ROWS_ALREADY_PRESENT',
        'UNVERIFIED_CUSTOMER_WHATSAPP_EVENTS',
      ]),
    )
  })
})
