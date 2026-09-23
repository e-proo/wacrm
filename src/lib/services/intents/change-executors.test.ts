import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(),
  serviceMaybeSingle: vi.fn(),
  intentMaybeSingle: vi.fn(),
  intentUpdate: vi.fn(),
}))

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}))

import { INTENTS_CHANGE_EXECUTORS } from './change-executors'

function installDb() {
  const serviceQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: mocks.serviceMaybeSingle,
  }
  serviceQuery.select.mockReturnValue(serviceQuery)
  serviceQuery.eq.mockReturnValue(serviceQuery)

  const intentQuery = {
    update: mocks.intentUpdate,
    eq: vi.fn(),
    select: vi.fn(),
    maybeSingle: mocks.intentMaybeSingle,
  }
  mocks.intentUpdate.mockReturnValue(intentQuery)
  intentQuery.eq.mockReturnValue(intentQuery)
  intentQuery.select.mockReturnValue(intentQuery)

  mocks.supabaseAdmin.mockReturnValue({
    from: vi.fn((table: string) =>
      table === 'services' ? serviceQuery : intentQuery,
    ),
  })
}

const context = {
  accountId: 'account-1',
  changeRequestId: 'change-1',
  actorUserId: 'admin-1',
}

const baseChange = {
  id: 'change-1',
  targetType: 'service_intent',
  targetId: 'intent-1',
  intent: 'update',
  proposedPayload: {},
  expectedVersion: null,
  contentDigest: 'digest',
  claimToken: 'claim-token',
}

const executor = INTENTS_CHANGE_EXECUTORS[0].executor

describe('Intents deterministic change executor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installDb()
    mocks.intentMaybeSingle.mockResolvedValue({
      data: { id: 'intent-1' },
      error: null,
    })
  })

  it('applies a fulfilled decision and returns the historical notification descriptor', async () => {
    await expect(
      executor(context, {
        ...baseChange,
        proposedPayload: { decision: 'fulfilled' },
      }),
    ).resolves.toMatchObject({
      target_type: 'service_intent',
      target_id: 'intent-1',
      operation: 'intent_decision',
      decision: 'fulfilled',
      customer_notification: {
        intent_id: 'intent-1',
        event_type: 'approved_and_applied',
      },
    })

    expect(mocks.intentUpdate).toHaveBeenCalledWith({ status: 'fulfilled' })
  })

  it('validates a matched service in the same account before applying the match', async () => {
    mocks.serviceMaybeSingle.mockResolvedValue({
      data: { id: 'service-1' },
      error: null,
    })

    await expect(
      executor(context, {
        ...baseChange,
        proposedPayload: {
          decision: 'matched',
          matched_service_id: 'service-1',
        },
      }),
    ).resolves.toMatchObject({
      decision: 'matched',
      customer_notification: {
        event_type: 'matched',
      },
    })

    expect(mocks.intentUpdate).toHaveBeenCalledWith({
      status: 'matched',
      matched_service_id: 'service-1',
    })
  })

  it('fails closed when the requested matched service does not exist', async () => {
    mocks.serviceMaybeSingle.mockResolvedValue({
      data: null,
      error: null,
    })

    await expect(
      executor(context, {
        ...baseChange,
        proposedPayload: {
          decision: 'matched',
          matched_service_id: 'missing-service',
        },
      }),
    ).rejects.toMatchObject({
      code: 'SERVICE_NOT_FOUND',
      status: 404,
    })

    expect(mocks.intentUpdate).not.toHaveBeenCalled()
  })
})
