import { describe, expect, it } from 'vitest'
import {
  inspectAgentTaskTestCutoverReadiness,
  setAgentTaskTestCutoverMode,
} from './cutover'

const accountId = process.env.WACRM_AGENT_TASK_CUTOVER_ACCOUNT_ID
const inspectEnabled =
  process.env.WACRM_AGENT_TASK_CUTOVER_LIVE === '1'
const activateEnabled =
  process.env.WACRM_AGENT_TASK_CUTOVER_ACTIVATE_LIVE === '1'
const rollbackEnabled =
  process.env.WACRM_AGENT_TASK_CUTOVER_ROLLBACK_LIVE === '1'

const inspectDescribe = inspectEnabled ? describe : describe.skip
const activateDescribe = activateEnabled ? describe : describe.skip
const rollbackDescribe = rollbackEnabled ? describe : describe.skip

function requireAccount(): string {
  if (!accountId) throw new Error('WACRM_AGENT_TASK_CUTOVER_ACCOUNT_ID_REQUIRED')
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error('SUPABASE_TEST_ENV_REQUIRED')
  }
  return accountId
}

inspectDescribe('Agent Task TEST cutover preflight', () => {
  it('prints account-scoped readiness without changing delivery mode', async () => {
    const readiness = await inspectAgentTaskTestCutoverReadiness({
      accountId: requireAccount(),
    })
    expect(['disabled', 'pilot', 'inconsistent']).toContain(readiness.mode)
    console.info(JSON.stringify(readiness, null, 2))
  }, 60_000)
})

activateDescribe('Agent Task TEST cutover activation', () => {
  it('activates pilot only after readiness is clean', async () => {
    if (process.env.WACRM_AGENT_TASK_CUTOVER_CONFIRM !== 'ACTIVATE_TEST_PILOT') {
      throw new Error('WACRM_AGENT_TASK_CUTOVER_ACTIVATION_CONFIRMATION_REQUIRED')
    }

    const resolvedAccountId = requireAccount()
    const before = await inspectAgentTaskTestCutoverReadiness({
      accountId: resolvedAccountId,
    })
    expect(before.mode).toBe('disabled')
    expect(before.ready).toBe(true)
    expect(before.blockers).toEqual([])

    const changed = await setAgentTaskTestCutoverMode({
      accountId: resolvedAccountId,
      mode: 'pilot',
      actorId: 'phase18-live-test',
    })

    expect(changed.after.mode).toBe('pilot')
    expect(changed.after.ready).toBe(true)
  }, 60_000)
})

rollbackDescribe('Agent Task TEST cutover rollback', () => {
  it('disables Task outbound delivery through the guarded rollback RPC', async () => {
    if (process.env.WACRM_AGENT_TASK_CUTOVER_CONFIRM !== 'ROLLBACK_TEST') {
      throw new Error('WACRM_AGENT_TASK_CUTOVER_ROLLBACK_CONFIRMATION_REQUIRED')
    }

    const resolvedAccountId = requireAccount()
    const changed = await setAgentTaskTestCutoverMode({
      accountId: resolvedAccountId,
      mode: 'disabled',
      actorId: 'phase18-live-test',
    })

    expect(changed.after.mode).toBe('disabled')
    expect(changed.after.runtime.outboundTaskDeliveryEnabled).toBe(false)
    expect(changed.after.whatsappScope.enabled).toBe(false)
  }, 60_000)
})
