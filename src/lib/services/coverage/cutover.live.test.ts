import { describe, expect, it } from 'vitest'
import {
  COVERAGE_CUSTOMER_BUSINESS_EVENT_TYPES,
  inspectCoverageBusinessEventCutoverReadiness,
  prepareCoverageBusinessEventShadowVerification,
} from './cutover'

const enabled = process.env.WACRM_COVERAGE_CUTOVER_LIVE === '1'
const liveDescribe = enabled ? describe : describe.skip

liveDescribe('Coverage cutover live TEST verification', () => {
  it('prepares real shadow parity evidence without activating delivery', async () => {
    const accountId = process.env.WACRM_COVERAGE_CUTOVER_LIVE_ACCOUNT_ID
    if (!accountId) {
      throw new Error('WACRM_COVERAGE_CUTOVER_LIVE_ACCOUNT_ID_REQUIRED')
    }
    if (
      !process.env.NEXT_PUBLIC_SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      throw new Error('SUPABASE_TEST_ENV_REQUIRED')
    }

    const before = await inspectCoverageBusinessEventCutoverReadiness({
      accountId,
    })
    expect(before.mode).toBe('legacy')

    const result = await prepareCoverageBusinessEventShadowVerification({
      accountId,
      limit: 50,
    })

    expect(result.readiness.mode).toBe('legacy')
    expect(result.readiness.requiredEventTypes).toBe(
      COVERAGE_CUSTOMER_BUSINESS_EVENT_TYPES.length,
    )
    expect(result.readiness.matchedEventTypes).toBe(
      COVERAGE_CUSTOMER_BUSINESS_EVENT_TYPES.length,
    )
    expect(result.readiness.matchedEventTypeKeys).toEqual(
      expect.arrayContaining([...COVERAGE_CUSTOMER_BUSINESS_EVENT_TYPES]),
    )
    expect(result.readiness.missingEventTypes).toEqual([])
    expect(result.readiness.blockers).toBe(0)
    expect(result.readiness.legacyNonterminal).toBe(0)
    expect(result.readiness.activeNonterminal).toBe(0)
    expect(result.readiness.ready).toBe(true)
    expect(result.rendering.failed).toBe(0)
    expect(result.rendering.unsupportedProjector).toBe(0)
    expect(result.rendering.mismatchedLegacy).toBe(0)
    expect(result.rendering.comparisonMissing).toBe(0)

    console.info(
      JSON.stringify(
        {
          recoveredStaleRows: result.recoveredStaleRows,
          requeuedRows: result.requeuedRows,
          rendering: result.rendering,
          readiness: result.readiness,
        },
        null,
        2,
      ),
    )
  }, 60_000)
})
