import { describe, expect, it } from 'vitest'
import {
  executeCoverageProposeOfferIntegrated,
  executeCoverageProposeRequest,
} from './business-handoff'
import type { ToolContext } from './executors'

function context(): ToolContext {
  return {
    accountId: 'account-1',
    agentId: 'agent-1',
    revisionId: 'revision-1',
    actorUserId: null,
    runId: 'run-1',
    grants: {},
    grantVersions: {},
    grantConstraints: {},
    plane: 'customer',
    channel: 'whatsapp',
    simulation: false,
    trustedAdminIdentityId: null,
    trustedAdminCapabilities: [],
    features: {
      killSwitch: false,
      nativeToolsEnabled: true,
      proposalToolsEnabled: true,
    },
    agentPurpose: 'customer_support',
    contactId: 'contact-1',
    conversationId: 'conversation-1',
    sourceMessageId: 'message-1',
  }
}

describe('Coverage integrated proposal money validation', () => {
  it('rejects non-canonical or non-positive offer amounts at the active boundary', async () => {
    await expect(
      executeCoverageProposeOfferIntegrated(context(), {
        service_id: 'service-1',
        total_amount: '1e3',
        currency: 'SAR',
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_AMOUNT',
    })

    await expect(
      executeCoverageProposeOfferIntegrated(context(), {
        service_id: 'service-1',
        total_amount: '-1',
        currency: 'SAR',
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_AMOUNT',
    })
  })

  it('rejects negative commissions before any proposal mutation', async () => {
    await expect(
      executeCoverageProposeRequest(context(), {
        service_id: 'service-1',
        requested_amount: '1000',
        currency: 'SAR',
        commission_per_thousand: '-0.1',
        commission_currency: 'SAR',
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_COMMISSION',
    })
  })
})
