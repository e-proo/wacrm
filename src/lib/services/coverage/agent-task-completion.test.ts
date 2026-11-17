import { describe, expect, it, vi } from 'vitest'
import { COVERAGE_SOURCING_COMPLETION_POLICY } from './agent-task'

const accountId = '33333333-3333-4333-8333-333333333333'
const taskId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'

const baseRequest = {
  id: requestId,
  requested_amount: '550',
  reserved_amount: '0',
  fulfilled_amount: '0',
  status: 'active',
}

type Request = typeof baseRequest
type Target = { status: string }

function fixture(request: Request | null, targets: Target[]) {
  const filters: { table: string; column: string; value: unknown }[] = []
  const from = vi.fn((table: string) => {
    const q = Object.assign(
      Promise.resolve({ data: targets, error: null }),
      {
        select: () => q,
        eq: (column: string, value: unknown) => {
          filters.push({ table, column, value })
          return q
        },
        maybeSingle: async () => ({ data: request, error: null }),
      },
    )
    return q
  })
  const db = { from } as unknown as Parameters<typeof COVERAGE_SOURCING_COMPLETION_POLICY.evaluate>[0]
  const context: Parameters<typeof COVERAGE_SOURCING_COMPLETION_POLICY.evaluate>[1] = {
    accountId,
    taskId,
    taskType: 'coverage.sourcing',
    taskTypeVersion: 2,
    taskContext: { coverageRequestId: requestId },
    targetPolicy: {},
  }
  return { db, context, from, filters }
}

describe('Coverage sourcing completion policy — Phase 11 regression', () => {
  it('closes sourcing after a completed, admin-approved supplier target even when funds are not reserved', async () => {
    const { db, context, filters } = fixture(baseRequest, [{ status: 'completed' }])
    const result = await COVERAGE_SOURCING_COMPLETION_POLICY.evaluate(db, context)
    expect(result).toMatchObject({
      status: 'completed',
      reason: 'supplier_offer_executed',
      payload: {
        coverageRequestId: requestId,
        requestStatus: 'active',
        remainingAmount: '550',
        completedSuppliers: 1,
        totalSuppliers: 1,
      },
    })
    expect(filters).toContainEqual({table:'coverage_requests',column:'account_id',value:accountId})
    expect(filters).toContainEqual({table:'coverage_requests',column:'id',value:requestId})
    expect(filters).toContainEqual({table:'ai_agent_task_targets',column:'account_id',value:accountId})
    expect(filters).toContainEqual({table:'ai_agent_task_targets',column:'task_id',value:taskId})
  })

  it('does not finish prematurely when another supplier is still actionable', async () => {
    const { db, context } = fixture(baseRequest,
      [{ status: 'completed' }, { status: 'awaiting_reply' }])
    await expect(COVERAGE_SOURCING_COMPLETION_POLICY.evaluate(db, context))
      .resolves.toMatchObject({
        status: 'continue',
        reason: 'coverage_targets_still_actionable',
        payload: { actionableTargets: 1 },
      })
  })

  it('does not call human handoff or a supplier refusal an approved business offer', async () => {
    for (const statuses of [
      ['paused_for_human'],
      ['exhausted'],
      ['opted_out'],
      ['failed'],
      ['paused_for_human', 'exhausted'],
    ]) {
      const { db, context } = fixture(baseRequest, statuses.map(status => ({ status })))
      const result = await COVERAGE_SOURCING_COMPLETION_POLICY.evaluate(db, context)
      expect(result.status).toBe('partially_completed')
      expect(result.reason).toBe('supplier_targets_exhausted')
    }
  })

  it('reports no candidates as partial, not falsely as an approved offer', async () => {
    const { db, context } = fixture(baseRequest, [])
    await expect(COVERAGE_SOURCING_COMPLETION_POLICY.evaluate(db, context))
      .resolves.toMatchObject({ status: 'partially_completed', reason: 'no_supplier_candidates' })
  })

  it('still finishes if the underlying Coverage Request was actually reserved or fulfilled', async () => {
    for (const request of [
      { ...baseRequest, reserved_amount: '550', status: 'fully_reserved' },
      { ...baseRequest, fulfilled_amount: '550', status: 'fulfilled' },
    ]) {
      const { db, context } = fixture(request, [{ status: 'awaiting_reply' }])
      await expect(COVERAGE_SOURCING_COMPLETION_POLICY.evaluate(db, context))
        .resolves.toMatchObject({
          status: 'completed',
          reason: 'coverage_request_satisfied',
          payload: { remainingAmount: '0' },
        })
    }
  })

  it('cancels sourcing if the authoritative Request is cancelled or expired', async () => {
    for (const status of ['cancelled', 'expired']) {
      const { db, context } = fixture({ ...baseRequest, status }, [{ status: 'awaiting_reply' }])
      await expect(COVERAGE_SOURCING_COMPLETION_POLICY.evaluate(db, context))
        .resolves.toMatchObject({
          status: 'cancelled', reason: 'coverage_request_terminal',
        })
    }
  })

  it('fails closed when the source Request is no longer visible in the task account', async () => {
    const { db, context } = fixture(null, [{ status: 'completed' }])
    await expect(COVERAGE_SOURCING_COMPLETION_POLICY.evaluate(db, context))
      .resolves.toMatchObject({ status: 'failed', reason: 'coverage_request_not_found' })
  })
})
