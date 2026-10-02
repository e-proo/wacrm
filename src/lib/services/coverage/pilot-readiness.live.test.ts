import { describe, expect, it } from 'vitest'
import { inspectCoverageSourcingPilotReadiness } from './pilot-readiness'

const enabled =
  process.env.WACRM_COVERAGE_PILOT_READINESS_LIVE === '1'
const liveDescribe = enabled ? describe : describe.skip

liveDescribe('Coverage sourcing Phase 19 pilot readiness', () => {
  it('inspects the exact draft/request without mutating pilot state', async () => {
    const accountId = required('WACRM_AGENT_TASK_CUTOVER_ACCOUNT_ID')
    const agentId = required('WACRM_COVERAGE_PILOT_AGENT_ID')
    const revisionId = required('WACRM_COVERAGE_PILOT_REVISION_ID')
    const coverageRequestId = required(
      'WACRM_COVERAGE_PILOT_REQUEST_ID',
    )

    const readiness = await inspectCoverageSourcingPilotReadiness({
      accountId,
      agentId,
      revisionId,
      coverageRequestId,
    })

    console.info(JSON.stringify(readiness, null, 2))

    const strict =
      process.env.WACRM_COVERAGE_PILOT_REQUIRE_READY ?? 'inspect'
    if (strict === 'publish') {
      expect(readiness.readyForPublish).toBe(true)
    } else if (strict === 'live') {
      expect(readiness.readyForLive).toBe(true)
    } else if (strict !== 'inspect') {
      throw new Error('WACRM_COVERAGE_PILOT_REQUIRE_READY_INVALID')
    }
  }, 60_000)
})

function required(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(key + '_REQUIRED')
  return value
}
