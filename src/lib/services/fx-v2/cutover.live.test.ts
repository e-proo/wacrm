import { describe, expect, it } from 'vitest'
import {
  FX_BUSINESS_EVENT_TYPES,
  inspectFxBusinessEventCutoverReadiness,
  prepareFxBusinessEventShadowVerification,
} from './cutover'

const enabled = process.env.WACRM_FX_CUTOVER_LIVE === '1'
const liveDescribe = enabled ? describe : describe.skip

liveDescribe('FX cutover live TEST verification', () => {
  it('prepares real shadow parity evidence without activating delivery', async () => {
    const accountId = process.env.WACRM_FX_CUTOVER_LIVE_ACCOUNT_ID
    if (!accountId) {
      throw new Error('WACRM_FX_CUTOVER_LIVE_ACCOUNT_ID_REQUIRED')
    }
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_TEST_ENV_REQUIRED')
    }

    const before = await inspectFxBusinessEventCutoverReadiness({ accountId })
    expect(before.mode).toBe('legacy')

    const result = await prepareFxBusinessEventShadowVerification({
      accountId,
      limit: 50,
    })

    expect(result.readiness.mode).toBe('legacy')
    expect(result.readiness.activeNonterminal).toBe(0)
    expect(result.readiness.requiredEventTypes).toBe(FX_BUSINESS_EVENT_TYPES.length)
    expect(result.rendering.failed).toBe(0)
    expect(result.rendering.unsupportedProjector).toBe(0)
    expect(result.rendering.mismatchedLegacy).toBe(0)

    console.info(
      JSON.stringify(
        {
          backfilledRows: result.backfilledRows,
          supersededLegacyRows: result.supersededLegacyRows,
          requeuedRows: result.requeuedRows,
          rendering: result.rendering,
          readiness: result.readiness,
        },
        null,
        2,
      ),
    )
  })
})
