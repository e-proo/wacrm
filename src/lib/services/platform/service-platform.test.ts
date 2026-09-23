import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { PlatformToolManifest } from '@/lib/ai/tools/platform/contracts'
import { getRegisteredTool } from '@/lib/ai/runtime/tool-registry'
import { getCurrentPlatformTool } from '@/lib/ai/tools/platform/current-domain-registry'
import { getCurrentToolDefinition } from '@/lib/ai/tools/platform/runtime-tool-compat'
import { COVERAGE_DOMAIN, COVERAGE_RUNTIME } from '@/lib/services/coverage/domain'
import { COVERAGE_TOOL_MANIFESTS } from '@/lib/services/coverage/tool-manifests'
import { FX_V2_DOMAIN, FX_V2_RUNTIME } from '@/lib/services/fx-v2/domain'
import { FX_V2_TOOL_MANIFESTS } from '@/lib/services/fx-v2/tool-manifests'
import {
  CURRENT_BUSINESS_DOMAIN_REGISTRY,
  CURRENT_CHANGE_EXECUTOR_REGISTRY,
  CURRENT_EVENT_PROJECTOR_REGISTRY,
} from './composition'
import { ChangeExecutorRegistry } from './change-executor-registry'
import { defineBusinessDomain } from './domain-contracts'
import { BusinessDomainRegistry } from './domain-registry'

const TEST_TOOL: PlatformToolManifest = {
  key: 'testing.read_item',
  version: 1,
  domain: 'testing',
  title: 'Read test item',
  description: 'Read a test item without changing state.',
  purpose: 'Exercise the platform registry contract.',
  whenToUse: ['A test needs a model-visible read tool.'],
  whenNotToUse: ['Never use it for mutation.'],
  inputSchema: { type: 'object', additionalProperties: false },
  outputSchema: { type: 'object' },
  permission: 'read',
  risk: 'read',
  allowedPlanes: ['customer'],
  requiredCapabilities: ['testing.read'],
  supportedGrantConstraints: ['channels'],
  sideEffect: 'none',
  approvalRequired: false,
  idempotent: true,
  audit: 'invocation',
  modelExposed: true,
  serverOnly: false,
  examples: [],
  errorContract: [
    {
      code: 'NOT_FOUND',
      safeToShow: true,
      meaning: 'The test item was not found.',
    },
  ],
}

const TEST_DOMAIN = defineBusinessDomain({
  key: 'testing',
  version: 1,
  title: 'Testing',
  description: 'A small domain used to prove extension without kernel changes.',
  capabilities: ['testing.read'],
  tools: [TEST_TOOL],
  changeActions: [
    {
      key: 'testing.item.update',
      version: 1,
      domain: 'testing',
      title: 'Update test item',
      description: 'Deterministically applies an approved test item update.',
      approvalRequired: true,
      idempotent: true,
      legacySelectors: [{ targetType: 'test_item', intent: 'update', targetId: 'present' }],
    },
  ],
  events: [
    {
      key: 'testing.item.updated',
      version: 1,
      domain: 'testing',
      title: 'Test item updated',
      description: 'A test item update became authoritative.',
      subjectTypes: ['test_item'],
      snapshotPolicy: 'embedded_event_snapshot',
    },
  ],
  messageTemplates: [
    {
      key: 'testing.item.updated',
      audience: 'internal',
      channel: 'in_app',
      locale: 'ar',
      body: 'تم تحديث العنصر.',
    },
  ],
})

describe('service platform domain contracts', () => {
  it('registers a complete domain and resolves its legacy bridge without kernel changes', () => {
    const registry = new BusinessDomainRegistry().register(TEST_DOMAIN)

    expect(registry.getDomain('testing')?.version).toBe(1)
    expect(registry.getTool('testing.read_item', 1)?.permission).toBe('read')
    expect(registry.getEvent('testing.item.updated', 1)?.snapshotPolicy).toBe(
      'embedded_event_snapshot',
    )
    expect(
      registry.resolveLegacyChangeAction({
        targetType: 'test_item',
        targetId: 'item-1',
        intent: 'update',
      })?.key,
    ).toBe('testing.item.update')
  })

  it('rejects duplicate domains and cross-domain legacy selector ambiguity', () => {
    const registry = new BusinessDomainRegistry().register(TEST_DOMAIN)
    expect(() => registry.register(TEST_DOMAIN)).toThrow('Duplicate business domain')

    const other = defineBusinessDomain({
      key: 'other',
      version: 1,
      title: 'Other',
      description: 'Second domain for selector collision testing.',
      capabilities: [],
      tools: [],
      changeActions: [
        {
          key: 'other.item.update',
          version: 1,
          domain: 'other',
          title: 'Other update',
          description: 'Competes for the same legacy selector.',
          approvalRequired: true,
          idempotent: true,
          legacySelectors: [{ targetType: 'test_item', intent: 'update', targetId: 'present' }],
        },
      ],
      events: [],
      messageTemplates: [],
    })

    expect(() => registry.register(other)).toThrow('Ambiguous legacy change selector')
  })
})

describe('change executor registry', () => {
  it('dispatches exact action versions and rejects missing or duplicate executors', async () => {
    const registry = new ChangeExecutorRegistry()
    registry.register({
      actionKey: 'testing.item.update',
      actionVersion: 1,
      executor: async (context, change) => ({
        account_id: context.accountId,
        target_id: change.targetId,
      }),
    })

    await expect(
      registry.execute(
        'testing.item.update',
        1,
        { accountId: 'acc-1', changeRequestId: 'cr-1', actorUserId: null },
        {
          id: 'cr-1',
          targetType: 'test_item',
          targetId: 'item-1',
          intent: 'update',
          proposedPayload: {},
          expectedVersion: null,
          contentDigest: 'digest',
          claimToken: 'claim',
        },
      ),
    ).resolves.toEqual({ account_id: 'acc-1', target_id: 'item-1' })

    expect(() =>
      registry.register({
        actionKey: 'testing.item.update',
        actionVersion: 1,
        executor: async () => ({}),
      }),
    ).toThrow('Duplicate change executor')

    await expect(
      registry.execute(
        'testing.item.update',
        2,
        { accountId: 'acc-1', changeRequestId: 'cr-1', actorUserId: null },
        {
          id: 'cr-1',
          targetType: 'test_item',
          targetId: 'item-1',
          intent: 'update',
          proposedPayload: {},
          expectedVersion: null,
          contentDigest: 'digest',
          claimToken: 'claim',
        },
      ),
    ).rejects.toThrow('CHANGE_EXECUTOR_NOT_REGISTERED')
  })
})

describe('FX V2 first-domain migration', () => {
  it('registers FX tools, change actions, canonical events, and deterministic executors', () => {
    expect(FX_V2_DOMAIN.tools.map((tool) => tool.key)).toEqual(
      expect.arrayContaining([
        'exchange_rates.get_current',
        'exchange_rates.record_trade_request',
        'exchange_rates.admin_list_pairs',
        'exchange_rates.propose_pair_change',
        'exchange_rates.admin_list_trade_requests',
        'exchange_rates.propose_trade_decision',
      ]),
    )
    expect(FX_V2_DOMAIN.changeActions.map((action) => action.key)).toEqual([
      'exchange_rates.pair.publish',
      'exchange_rates.trade.decide',
    ])
    expect(FX_V2_DOMAIN.events.map((event) => event.key)).toEqual([
      'exchange_rate.trade.requested',
      'exchange_rate.trade.approved',
      'exchange_rate.trade.rejected',
      'exchange_rate.trade.completed',
    ])

    expect(
      CURRENT_BUSINESS_DOMAIN_REGISTRY.resolveLegacyChangeAction({
        targetType: 'fx_rate_pair',
        targetId: 'pair-1',
        intent: 'update',
      })?.key,
    ).toBe('exchange_rates.pair.publish')
    expect(CURRENT_CHANGE_EXECUTOR_REGISTRY.has('exchange_rates.pair.publish', 1)).toBe(true)
    expect(CURRENT_CHANGE_EXECUTOR_REGISTRY.has('exchange_rates.trade.decide', 1)).toBe(true)
  })

  it('removes FX-specific deterministic branches from the generic change-request executor', () => {
    const source = readFileSync(
      new URL('../../ai/runtime/change-request-executor.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain('tryExecuteCurrentChangeAction')
    expect(source).not.toContain('publishFxRateVersion')
    expect(source).not.toContain('decideFxTradeRequest')
    expect(source).not.toContain("row.target_type === 'fx_rate_pair'")
    expect(source).not.toContain("row.target_type === 'fx_trade_request'")
  })
})


describe('Coverage second-domain migration', () => {
  it('registers Coverage through the same domain/change-executor platform', () => {
    expect(COVERAGE_DOMAIN.tools.map((tool) => tool.key)).toEqual(
      expect.arrayContaining([
        'coverage.check_availability',
        'coverage.find_offers',
        'coverage.get_rates',
        'coverage.propose_offer',
        'coverage.propose_request',
        'coverage.admin_list_offers',
        'coverage.admin_list_requests',
      ]),
    )
    expect(COVERAGE_DOMAIN.changeActions.map((action) => action.key)).toEqual([
      'coverage.offer.create',
      'coverage.request.create',
    ])

    expect(
      CURRENT_BUSINESS_DOMAIN_REGISTRY.resolveLegacyChangeAction({
        targetType: 'coverage_offer',
        targetId: null,
        intent: 'create',
      })?.key,
    ).toBe('coverage.offer.create')
    expect(
      CURRENT_BUSINESS_DOMAIN_REGISTRY.resolveLegacyChangeAction({
        targetType: 'coverage_request',
        targetId: null,
        intent: 'create',
      })?.key,
    ).toBe('coverage.request.create')

    expect(CURRENT_CHANGE_EXECUTOR_REGISTRY.has('coverage.offer.create', 1)).toBe(true)
    expect(CURRENT_CHANGE_EXECUTOR_REGISTRY.has('coverage.request.create', 1)).toBe(true)
  })

  it('keeps Coverage mutation branches out of the generic change-request executor', () => {
    const source = readFileSync(
      new URL('../../ai/runtime/change-request-executor.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain('tryExecuteCurrentChangeAction')
    expect(source).not.toContain("row.target_type === 'coverage_offer'")
    expect(source).not.toContain("row.target_type === 'coverage_request'")
  })
})


describe('native domain tool ownership', () => {
  const nativeManifests = [...FX_V2_TOOL_MANIFESTS, ...COVERAGE_TOOL_MANIFESTS]

  it('makes the business domains own their native platform manifests', () => {
    expect(FX_V2_DOMAIN.tools).toEqual(FX_V2_TOOL_MANIFESTS)
    expect(COVERAGE_DOMAIN.tools).toEqual(COVERAGE_TOOL_MANIFESTS)

    expect(getCurrentPlatformTool('exchange_rates.get_current', 1)).toEqual(
      FX_V2_TOOL_MANIFESTS.find((tool) => tool.key === 'exchange_rates.get_current'),
    )
    expect(getCurrentPlatformTool('coverage.get_rates', 1)).toEqual(
      COVERAGE_TOOL_MANIFESTS.find((tool) => tool.key === 'coverage.get_rates'),
    )
  })

  it('contracts native tools out of the central registry while preserving the API compatibility projection', () => {
    for (const manifest of nativeManifests) {
      expect(getRegisteredTool(manifest.key), manifest.key).toBeNull()

      const projected = getCurrentToolDefinition(manifest.key, manifest.version)
      expect(projected, manifest.key).not.toBeNull()
      expect(projected?.version, manifest.key).toBe(manifest.version)
      expect(projected?.description, manifest.key).toBe(manifest.description)
      expect(projected?.argumentSchema, manifest.key).toEqual(manifest.inputSchema)
      expect(projected?.returnSchema, manifest.key).toBe(
        manifest.outputSchema.description,
      )
    }
  })

  it('removes FX and Coverage semantic specs from both the legacy bridge and central tool registry', () => {
    const registrySource = readFileSync(
      new URL('../../ai/tools/platform/current-domain-registry.ts', import.meta.url),
      'utf8',
    )
    const legacyToolRegistrySource = readFileSync(
      new URL('../../ai/runtime/tool-registry.ts', import.meta.url),
      'utf8',
    )

    expect(registrySource).toContain('FX_V2_TOOL_MANIFESTS')
    expect(registrySource).toContain('COVERAGE_TOOL_MANIFESTS')
    expect(registrySource).not.toContain("key: 'exchange_rates.")
    expect(registrySource).not.toContain("key: 'coverage.")
    expect(legacyToolRegistrySource).not.toContain("key: 'exchange_rates.")
    expect(legacyToolRegistrySource).not.toContain("key: 'coverage.")
  })
})


describe('domain-owned model tool executors', () => {
  it('binds every native FX and Coverage manifest to an exact-version domain runtime executor', () => {
    expect(
      FX_V2_RUNTIME.toolExecutors.map(({ key, version }) => key + '@' + version),
    ).toEqual(FX_V2_TOOL_MANIFESTS.map(({ key, version }) => key + '@' + version))

    expect(
      COVERAGE_RUNTIME.toolExecutors.map(({ key, version }) => key + '@' + version),
    ).toEqual(COVERAGE_TOOL_MANIFESTS.map(({ key, version }) => key + '@' + version))
  })

  it('keeps native tool names and implementation imports out of the central executor registry', () => {
    const source = readFileSync(
      new URL('../../ai/tools/platform/current-executor-registry.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain('CURRENT_BUSINESS_DOMAIN_RUNTIMES')
    expect(source).not.toContain("add('exchange_rates.")
    expect(source).not.toContain("add('coverage.")
    expect(source).not.toContain('executeFxV2')
    expect(source).not.toContain('executeCoverage')
  })
})


describe('Coverage business-event registration', () => {
  it('registers the canonical Coverage event catalog in the shared domain registry', () => {
    expect(
      CURRENT_BUSINESS_DOMAIN_REGISTRY.getEvent('coverage.offer.approved', 1)?.snapshotPolicy,
    ).toBe('embedded_event_snapshot')
    expect(
      CURRENT_BUSINESS_DOMAIN_REGISTRY.getEvent('coverage.request.approved', 1)?.subjectTypes,
    ).toEqual(['coverage_request'])
    expect(
      CURRENT_BUSINESS_DOMAIN_REGISTRY.getEvent('coverage.match.reserved', 1)?.subjectTypes,
    ).toEqual(['coverage_match'])
    expect(
      CURRENT_BUSINESS_DOMAIN_REGISTRY.getEvent('coverage.match.released', 1)?.subjectTypes,
    ).toEqual(['coverage_match'])
  })
})


describe('domain-owned event projectors', () => {
  it('registers exact-version FX and customer Coverage projectors through domain runtimes', () => {
    expect(FX_V2_RUNTIME.eventProjectors.map(({ eventType }) => eventType)).toEqual([
      'exchange_rate.trade.requested',
      'exchange_rate.trade.approved',
      'exchange_rate.trade.rejected',
      'exchange_rate.trade.completed',
    ])
    expect(COVERAGE_RUNTIME.eventProjectors.map(({ eventType }) => eventType)).toEqual([
      'coverage.offer.approved',
      'coverage.request.approved',
    ])

    for (const registration of [
      ...FX_V2_RUNTIME.eventProjectors,
      ...COVERAGE_RUNTIME.eventProjectors,
    ]) {
      expect(
        CURRENT_EVENT_PROJECTOR_REGISTRY.has(
          registration.eventType,
          registration.eventVersion,
        ),
        registration.eventType,
      ).toBe(true)
    }
  })

  it('does not invent projectors for Coverage lifecycle events without customer templates', () => {
    expect(CURRENT_EVENT_PROJECTOR_REGISTRY.has('coverage.match.reserved', 1)).toBe(false)
    expect(CURRENT_EVENT_PROJECTOR_REGISTRY.has('coverage.match.released', 1)).toBe(false)
    expect(CURRENT_EVENT_PROJECTOR_REGISTRY.has('coverage.offer.cancelled', 1)).toBe(false)
  })
})


describe('messaging purity', () => {
  it('keeps Coverage commission arithmetic out of the messaging layer', () => {
    const renderer = readFileSync(
      new URL('../../messaging/coverage-customer.ts', import.meta.url),
      'utf8',
    )
    const projector = readFileSync(
      new URL('../coverage/message-projectors.ts', import.meta.url),
      'utf8',
    )
    const executor = readFileSync(
      new URL('../coverage/change-executors.ts', import.meta.url),
      'utf8',
    )

    expect(renderer).not.toContain('calculateCommission')
    expect(renderer).not.toContain('commissionPerThousand')
    expect(renderer).not.toContain('/ 1000')
    expect(projector).toContain('commission_amount')
    expect(projector).not.toContain('commission_per_thousand /')
    expect(executor).toContain('commission_amount')
  })
})


describe('platform-generic service request projectors', () => {
  it('registers generic service_request events without inventing a business domain', () => {
    for (const eventType of [
      'service_request.approved',
      'service_request.rejected',
      'service_request.matched',
      'service_request.needs_clarification',
      'service_request.completed',
    ]) {
      expect(CURRENT_EVENT_PROJECTOR_REGISTRY.has(eventType, 1), eventType).toBe(true)
    }

    expect(CURRENT_BUSINESS_DOMAIN_REGISTRY.getDomain('platform')).toBeNull()
  })
})


describe('shared service primitives cleanup', () => {
  it('uses the shared decimal parser for Coverage money validation and removes dead manual arithmetic', () => {
    const coverageExecutors = readFileSync(
      new URL('../../ai/tools/executors.ts', import.meta.url),
      'utf8',
    )
    const fxEngine = readFileSync(
      new URL('../fx-v2/engine.ts', import.meta.url),
      'utf8',
    )

    expect(coverageExecutors).toContain(
      "import { parseDecimal } from '@/lib/services/pricing/decimal'",
    )
    expect(coverageExecutors).toContain(
      "parseDecimal(args.total_amount, { rejectZero: true })",
    )
    expect(coverageExecutors).toContain(
      'parseDecimal(args.commission_per_thousand)',
    )
    expect(coverageExecutors).not.toContain('Number(args.total_amount)')
    expect(coverageExecutors).not.toContain('Number(args.commission_per_thousand)')
    expect(coverageExecutors).not.toContain('function addDecimalStrings')
    expect(coverageExecutors).not.toContain('function negDecimalStrings')
    expect(fxEngine).toContain(
      "import { parseDecimal } from '@/lib/services/pricing/decimal'",
    )

    const coverageChangeExecutors = readFileSync(
      new URL('../coverage/change-executors.ts', import.meta.url),
      'utf8',
    )
    expect(coverageChangeExecutors).toContain(
      "import { parseDecimal } from '@/lib/services/pricing/decimal'",
    )
    expect(coverageChangeExecutors).toContain(
      "parseDecimal(payload.total_amount, { rejectZero: true })",
    )
    expect(coverageChangeExecutors).toContain(
      "parseDecimal(payload.requested_amount, { rejectZero: true })",
    )
    expect(coverageChangeExecutors).not.toContain('Number(payload.requested_amount)')
  })
})
