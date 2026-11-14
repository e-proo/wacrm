import { describe, expect, it } from 'vitest'
import { buildAgentTaskPlatform } from '@/lib/ai/tasks/target-resolution'
import {
  COVERAGE_SOURCING_MESSAGE_POLICY,
  COVERAGE_SOURCING_TASK_MODULE,
  COVERAGE_SOURCING_TASK_TYPE,
  COVERAGE_SOURCING_TASK_TYPE_V2,
  COVERAGE_SOURCING_MESSAGE_POLICY_V2,
  buildCoverageSupplierCandidates,
  parseCoverageSelectedContactId,
  coverageOfferMatchesSourcingRequest,
  supplierHistorySortKey,
} from './agent-task'
import { COVERAGE_DOMAIN } from './domain'
import type { CoverageAttributes } from './attributes'

const NORTH = '00000000-0000-4000-8000-000000000111'
const SOUTH = '00000000-0000-4000-8000-000000000222'
const REQUESTER = '00000000-0000-4000-8000-000000000333'
const SUPPLIER_A = '00000000-0000-4000-8000-000000000444'
const SUPPLIER_B = '00000000-0000-4000-8000-000000000555'

function requestAttributes(): CoverageAttributes {
  return {
    coverage_scope: 'domestic',
    coverage_country: null,
    pay_region_id: NORTH,
    pay_method: 'cash',
    receive_region_id: SOUTH,
    receive_method: 'networks',
  }
}

function matchingOfferAttributes(): CoverageAttributes {
  return {
    coverage_scope: 'domestic',
    coverage_country: null,
    pay_region_id: SOUTH,
    pay_method: 'networks',
    receive_region_id: NORTH,
    receive_method: 'cash',
  }
}

describe('Coverage sourcing Agent Task', () => {
  it('registers one same-domain Task Type / resolver / message policy', () => {
    const platform = buildAgentTaskPlatform([COVERAGE_SOURCING_TASK_MODULE])
    const manifest = platform.taskTypes.get('coverage.sourcing', 1)

    expect(manifest).toBeTruthy()
    expect(manifest?.requiredAgentCapabilities).toContain('coverage.sourcing')
    expect(manifest?.requiredTaskApproval).toBe('task')
    expect(manifest?.allowedTools).toEqual([
      { key: 'coverage.get_rates', version: 1 },
      { key: 'coverage.propose_offer', version: 2 },
    ])
    expect(
      platform.targetResolvers.get('coverage.supplier_candidates')?.domain,
    ).toBe('coverage')
    expect(
      platform.outboundMessagePolicies.get(
        'coverage.sourcing_message',
        1,
      )?.domain,
    ).toBe('coverage')
    expect(COVERAGE_DOMAIN.capabilities).toContain('coverage.sourcing')
  })

  it('matches supplier history anti-parallel to the requester legs', () => {
    expect(
      coverageOfferMatchesSourcingRequest(
        requestAttributes(),
        matchingOfferAttributes(),
      ),
    ).toBe(true)

    expect(
      coverageOfferMatchesSourcingRequest(
        requestAttributes(),
        requestAttributes(),
      ),
    ).toBe(false)
  })

  it('treats explicit any methods as deterministic wildcards', () => {
    expect(
      coverageOfferMatchesSourcingRequest(requestAttributes(), {
        ...matchingOfferAttributes(),
        pay_method: 'any',
        receive_method: 'any',
      }),
    ).toBe(true)
  })

  it('selects historical providers without making supplier a permanent contact type', () => {
    const request = {
      id: '00000000-0000-4000-8000-000000000666',
      service_id: '00000000-0000-4000-8000-000000000777',
      requester_contact_id: REQUESTER,
      requested_amount: '100000',
      reserved_amount: '0',
      fulfilled_amount: '0',
      currency: 'SAR',
      attributes:
        requestAttributes() as unknown as Record<string, unknown>,
      status: 'active',
    }

    const candidates = buildCoverageSupplierCandidates(
      request,
      [
        {
          provider_contact_id: REQUESTER,
          attributes:
            matchingOfferAttributes() as unknown as Record<string, unknown>,
          status: 'active',
          created_at: '2026-09-28T00:00:00.000Z',
        },
        {
          provider_contact_id: SUPPLIER_A,
          attributes:
            requestAttributes() as unknown as Record<string, unknown>,
          status: 'active',
          created_at: '2026-09-28T00:00:00.000Z',
        },
        {
          provider_contact_id: SUPPLIER_A,
          attributes:
            matchingOfferAttributes() as unknown as Record<string, unknown>,
          status: 'fulfilled',
          created_at: '2026-09-27T00:00:00.000Z',
        },
        {
          provider_contact_id: SUPPLIER_B,
          attributes:
            matchingOfferAttributes() as unknown as Record<string, unknown>,
          status: 'active',
          created_at: '2026-09-26T00:00:00.000Z',
        },
      ],
    )

    expect(candidates.map((candidate) => candidate.contactId)).toEqual([
      SUPPLIER_A,
      SUPPLIER_B,
    ])
    expect(candidates.every((candidate) => candidate.counterpartyRole === 'coverage_supplier')).toBe(true)
    expect(candidates.some((candidate) => candidate.contactId === REQUESTER)).toBe(false)
  })

  it('restricts manual sourcing to the selected existing supplier only', () => {
    const request = {
      id: '00000000-0000-4000-8000-000000000666',
      service_id: '00000000-0000-4000-8000-000000000777',
      requester_contact_id: REQUESTER,
      requested_amount: '100000',
      reserved_amount: '0',
      fulfilled_amount: '0',
      currency: 'SAR',
      attributes: requestAttributes() as unknown as Record<string, unknown>,
      status: 'active',
    }
    const eligibleRows = [
      {
        provider_contact_id: SUPPLIER_A,
        attributes: matchingOfferAttributes() as unknown as Record<string, unknown>,
        status: 'active' as const, created_at: '2026-11-14T12:00:00Z',
      },
      {
        provider_contact_id: SUPPLIER_B,
        attributes: matchingOfferAttributes() as unknown as Record<string, unknown>,
        status: 'active' as const, created_at: '2026-11-14T12:01:00Z',
      },
    ]
    expect(buildCoverageSupplierCandidates(request, eligibleRows, [], SUPPLIER_A)
      .map((item) => item.contactId)).toEqual([SUPPLIER_A])
    expect(buildCoverageSupplierCandidates(request, eligibleRows, [], REQUESTER))
      .toHaveLength(0)
    expect(buildCoverageSupplierCandidates(request, eligibleRows, [], NORTH))
      .toHaveLength(0)
    expect(buildCoverageSupplierCandidates(request, [
      { ...eligibleRows[0], attributes: requestAttributes() as unknown as Record<string, unknown> },
    ], [], SUPPLIER_A)).toHaveLength(0)
  })

  it('validates manually selected contact ID and never treats malformed selection as automatic', () => {
    expect(parseCoverageSelectedContactId({})).toBe(null)
    expect(parseCoverageSelectedContactId({ selectedContactId: SUPPLIER_B })).toBe(SUPPLIER_B)
    expect(() => parseCoverageSelectedContactId({ selectedContactId: null }))
      .toThrow('COVERAGE_SOURCING_SELECTED_CONTACT_INVALID')
    expect(() => parseCoverageSelectedContactId({ selectedContactId: 'another-tenant' }))
      .toThrow('COVERAGE_SOURCING_SELECTED_CONTACT_INVALID')
  })

  it('prioritizes currently active supplier history before old terminal history', () => {
    const activeKey = supplierHistorySortKey({
      status: 'active',
      created_at: '2026-09-20T00:00:00.000Z',
    })
    const fulfilledKey = supplierHistorySortKey({
      status: 'fulfilled',
      created_at: '2026-09-28T00:00:00.000Z',
    })

    expect(activeKey.localeCompare(fulfilledKey)).toBeLessThan(0)
  })

  it('prepares a template-only initial outreach without requester identity or supplier internals', async () => {
    const candidate = await COVERAGE_SOURCING_MESSAGE_POLICY.prepare({
      accountId: 'account',
      runId: 'run',
      taskId: 'task',
      taskTargetId: 'target',
      taskType: COVERAGE_SOURCING_TASK_TYPE.key,
      taskTypeVersion: 1,
      objective: 'Source coverage',
      taskContext: {
        coverageRequestId: '00000000-0000-4000-8000-000000000666',
        requesterName: 'MUST_NOT_LEAK',
        request: {
          remainingAmount: '75000',
          currency: 'SAR',
          providerCost: 'MUST_NOT_LEAK',
        },
      },
      targetPolicy: {},
      counterpartyRole: 'coverage_supplier',
      policy: COVERAGE_SOURCING_TASK_TYPE.messagePolicy,
      modelCandidateText: 'model free text is not transport authority',
    })

    expect(candidate).toEqual({
      kind: 'template',
      templateName: 'coverage_sourcing_supplier_v1',
      language: 'ar',
      params: ['75000', 'SAR'],
    })
    expect(JSON.stringify(candidate)).not.toContain('MUST_NOT_LEAK')
    expect(JSON.stringify(candidate)).not.toContain('model free text')
  })

  it('registers v2 without modifying the frozen v1 policy', () => {
    const platform = buildAgentTaskPlatform([COVERAGE_SOURCING_TASK_MODULE])
    expect(platform.taskTypes.get('coverage.sourcing', 1)?.messagePolicy.version).toBe(1)
    expect(platform.taskTypes.get('coverage.sourcing', 2)?.messagePolicy.version).toBe(2)
    expect(platform.outboundMessagePolicies.get('coverage.sourcing_message', 2)).toBeTruthy()
  })

  it('selects Meta approved template or deterministic OpenWA text by frozen provider', async () => {
    const ctx = {
      accountId: 'account', runId: 'run', taskId: 'task', taskTargetId: 'target',
      taskType: 'coverage.sourcing', taskTypeVersion: 2,
      objective: 'source', taskContext: {
        request: { remainingAmount: '75000', currency: 'SAR', requesterName: 'PRIVATE' },
        requesterName: 'PRIVATE',
      }, targetPolicy: {}, counterpartyRole: 'coverage_supplier',
      policy: COVERAGE_SOURCING_TASK_TYPE_V2.messagePolicy,
      modelCandidateText: 'MODEL_INJECTION_PRIVATE',
    }
    const meta = await COVERAGE_SOURCING_MESSAGE_POLICY_V2.prepare({
      ...ctx, whatsappProvider: 'meta_cloud',
    })
    expect(meta).toEqual({
      kind: 'template', templateName: 'coverage_sourcing_supplier_v1',
      language: 'ar', params: ['75000', 'SAR'],
    })
    const wa = await COVERAGE_SOURCING_MESSAGE_POLICY_V2.prepare({
      ...ctx, whatsappProvider: 'openwa',
    })
    expect(wa.kind).toBe('text')
    expect(wa).toMatchObject({ text: expect.stringContaining('75000 SAR') })
    expect(JSON.stringify(wa)).not.toMatch(/PRIVATE|MODEL_INJECTION/)
    expect(JSON.stringify(wa)).toContain('إيقاف')
    await expect(COVERAGE_SOURCING_MESSAGE_POLICY_V2.prepare(ctx))
      .rejects.toThrow(/PROVIDER_UNRESOLVED/)
    await expect(COVERAGE_SOURCING_MESSAGE_POLICY_V2.prepare({
      ...ctx, whatsappProvider: 'openwa',
      taskContext: { request: { remainingAmount: '1;SECRET', currency: 'SAR' } },
    })).rejects.toThrow(/MESSAGE_FACTS_INVALID/)
  })

  it('fails closed when the frozen request snapshot is missing', async () => {
    await expect(
      COVERAGE_SOURCING_MESSAGE_POLICY.prepare({
        accountId: 'account',
        runId: 'run',
        taskId: 'task',
        taskTargetId: 'target',
        taskType: COVERAGE_SOURCING_TASK_TYPE.key,
        taskTypeVersion: 1,
        objective: 'Source coverage',
        taskContext: {},
        targetPolicy: {},
        counterpartyRole: 'coverage_supplier',
        policy: COVERAGE_SOURCING_TASK_TYPE.messagePolicy,
        modelCandidateText: null,
      }),
    ).rejects.toThrow(/REQUEST_SNAPSHOT_REQUIRED/)
  })
})
