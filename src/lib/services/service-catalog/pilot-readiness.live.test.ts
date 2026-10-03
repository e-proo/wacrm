import { describe, expect, it } from 'vitest'
import { inspectServicePromotionPilotReadiness } from './pilot-readiness'

const enabled =
  process.env.WACRM_SERVICE_PROMOTION_PILOT_READINESS_LIVE === '1'
const liveDescribe = enabled ? describe : describe.skip

liveDescribe('Service Promotion Phase 20 pilot readiness', () => {
  it('inspects the frozen TEST segment without mutating it', async () => {
    const readiness = await inspectServicePromotionPilotReadiness({
      accountId: required('WACRM_AGENT_TASK_CUTOVER_ACCOUNT_ID'),
      agentId: required('WACRM_SERVICE_PROMOTION_PILOT_AGENT_ID'),
      revisionId: required(
        'WACRM_SERVICE_PROMOTION_PILOT_REVISION_ID',
      ),
      serviceId: required('WACRM_SERVICE_PROMOTION_PILOT_SERVICE_ID'),
    })

    console.info(JSON.stringify(readiness, null, 2))

    const strict =
      process.env.WACRM_SERVICE_PROMOTION_PILOT_REQUIRE_READY ??
      'inspect'
    if (strict === 'publish') {
      expect(readiness.readyForPublish).toBe(true)
    } else if (strict === 'live') {
      expect(readiness.readyForLive).toBe(true)
    } else if (strict !== 'inspect') {
      throw new Error(
        'WACRM_SERVICE_PROMOTION_PILOT_REQUIRE_READY_INVALID',
      )
    }
  }, 60_000)
})

function required(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(key + '_REQUIRED')
  return value
}
