import { describe, expect, it } from 'vitest'
import {
  inspectIntentsBusinessEventCutoverReadiness,
  setIntentsBusinessEventDeliveryMode,
} from './cutover'

const accountId = process.env.WACRM_INTENTS_CUTOVER_LIVE_ACCOUNT_ID
const activateEnabled =
  process.env.WACRM_INTENTS_CUTOVER_ACTIVATE_LIVE === '1'
const rollbackEnabled =
  process.env.WACRM_INTENTS_CUTOVER_ROLLBACK_LIVE === '1'

const activateDescribe = activateEnabled ? describe : describe.skip
const rollbackDescribe = rollbackEnabled ? describe : describe.skip

function requireLiveAccount(): string {
  if (!accountId) {
    throw new Error('WACRM_INTENTS_CUTOVER_LIVE_ACCOUNT_ID_REQUIRED')
  }
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    throw new Error('SUPABASE_TEST_ENV_REQUIRED')
  }
  return accountId
}

activateDescribe('Intents controlled cutover activation on TEST', () => {
  it('activates only after a successful readiness preflight', async () => {
    if (process.env.WACRM_INTENTS_CUTOVER_CONFIRM !== 'ACTIVATE_TEST') {
      throw new Error(
        'WACRM_INTENTS_CUTOVER_ACTIVATION_CONFIRMATION_REQUIRED',
      )
    }

    const resolvedAccountId = requireLiveAccount()
    const before = await inspectIntentsBusinessEventCutoverReadiness({
      accountId: resolvedAccountId,
    })

    expect(before.mode).toBe('legacy')
    expect(before.ready).toBe(true)
    expect(before.matchedEventTypes).toBe(before.requiredEventTypes)
    expect(before.blockers).toBe(0)
    expect(before.legacyNonterminal).toBe(0)
    expect(before.activeNonterminal).toBe(0)

    const activated = await setIntentsBusinessEventDeliveryMode({
      accountId: resolvedAccountId,
      mode: 'active',
    })
    expect(activated.mode).toBe('active')

    try {
      const after = await inspectIntentsBusinessEventCutoverReadiness({
        accountId: resolvedAccountId,
      })
      expect(after.mode).toBe('active')
      expect(after.activeNonterminal).toBe(0)
    } catch (error) {
      await setIntentsBusinessEventDeliveryMode({
        accountId: resolvedAccountId,
        mode: 'legacy',
      }).catch(() => undefined)
      throw error
    }
  }, 60_000)
})

rollbackDescribe('Intents controlled cutover rollback on TEST', () => {
  it('returns the route to legacy through the guarded rollback RPC', async () => {
    if (process.env.WACRM_INTENTS_CUTOVER_CONFIRM !== 'ROLLBACK_TEST') {
      throw new Error(
        'WACRM_INTENTS_CUTOVER_ROLLBACK_CONFIRMATION_REQUIRED',
      )
    }

    const resolvedAccountId = requireLiveAccount()
    const rolledBack = await setIntentsBusinessEventDeliveryMode({
      accountId: resolvedAccountId,
      mode: 'legacy',
    })
    expect(rolledBack.mode).toBe('legacy')

    const after = await inspectIntentsBusinessEventCutoverReadiness({
      accountId: resolvedAccountId,
    })
    expect(after.mode).toBe('legacy')
    expect(after.activeNonterminal).toBe(0)
  }, 60_000)
})
