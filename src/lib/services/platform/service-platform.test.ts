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
import { INTENTS_DOMAIN, INTENTS_RUNTIME } from '@/lib/services/intents/domain'
import { INTENTS_TOOL_MANIFESTS } from '@/lib/services/intents/tool-manifests'
import { SERVICES_DOMAIN, SERVICES_RUNTIME } from '@/lib/services/service-catalog/domain'
import { SERVICES_TOOL_MANIFESTS } from '@/lib/services/service-catalog/tool-manifests'
import { PRICING_DOMAIN, PRICING_RUNTIME } from '@/lib/services/pricing/domain'
import { PRICING_TOOL_MANIFESTS } from '@/lib/services/pricing/tool-manifests'
import { PRICING_RULES_DOMAIN, PRICING_RULES_RUNTIME } from '@/lib/services/pricing-rules/domain'
import { PRICING_RULES_TOOL_MANIFESTS } from '@/lib/services/pricing-rules/tool-manifests'
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

  it('resolves exact action identity before legacy metadata and falls back for historical rows', () => {
    const registry = new BusinessDomainRegistry().register(TEST_DOMAIN)

    expect(
      registry.resolveChangeAction({
        actionKey: 'testing.item.update',
        actionVersion: 1,
        targetType: 'totally_unrelated_target',
        targetId: null,
        intent: 'archive',
      })?.key,
    ).toBe('testing.item.update')

    expect(
      registry.resolveChangeAction({
        actionKey: null,
        actionVersion: null,
        targetType: 'test_item',
        targetId: 'item-1',
        intent: 'update',
      })?.key,
    ).toBe('testing.item.update')

    expect(() =>
      registry.resolveChangeAction({
        actionKey: 'testing.item.update',
        actionVersion: null,
        targetType: 'test_item',
        targetId: 'item-1',
        intent: 'update',
      }),
    ).toThrow('CHANGE_ACTION_IDENTITY_INCOMPLETE')
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
          actionKey: 'testing.item.update',
          actionVersion: 1,
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
          actionKey: 'testing.item.update',
          actionVersion: 2,
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
  const nativeManifests = [
    ...FX_V2_TOOL_MANIFESTS,
    ...COVERAGE_TOOL_MANIFESTS,
    ...INTENTS_TOOL_MANIFESTS,
  ]

  it('makes the business domains own their native platform manifests', () => {
    expect(FX_V2_DOMAIN.tools).toEqual(FX_V2_TOOL_MANIFESTS)
    expect(COVERAGE_DOMAIN.tools).toEqual(COVERAGE_TOOL_MANIFESTS)
    expect(INTENTS_DOMAIN.tools).toEqual(INTENTS_TOOL_MANIFESTS)

    expect(getCurrentPlatformTool('exchange_rates.get_current', 1)).toEqual(
      FX_V2_TOOL_MANIFESTS.find((tool) => tool.key === 'exchange_rates.get_current'),
    )
    expect(getCurrentPlatformTool('coverage.get_rates', 1)).toEqual(
      COVERAGE_TOOL_MANIFESTS.find((tool) => tool.key === 'coverage.get_rates'),
    )
    expect(getCurrentPlatformTool('intents.record', 1)).toEqual(
      INTENTS_TOOL_MANIFESTS.find((tool) => tool.key === 'intents.record'),
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

  it('removes FX, Coverage, and Intents semantic specs from both the legacy bridge and central tool registry', () => {
    const registrySource = readFileSync(
      new URL('../../ai/tools/platform/current-domain-registry.ts', import.meta.url),
      'utf8',
    )
    const legacyToolRegistrySource = readFileSync(
      new URL('../../ai/runtime/tool-registry.ts', import.meta.url),
      'utf8',
    )

    expect(registrySource).toContain('CURRENT_BUSINESS_DOMAIN_MODULES')
    expect(registrySource).not.toContain('const NATIVE_DOMAINS')
    expect(registrySource).not.toContain('FX_V2_TOOL_MANIFESTS')
    expect(registrySource).not.toContain('COVERAGE_TOOL_MANIFESTS')
    expect(registrySource).not.toContain('INTENTS_TOOL_MANIFESTS')
    expect(registrySource).not.toContain("key: 'exchange_rates.")
    expect(registrySource).not.toContain("key: 'coverage.")
    expect(registrySource).not.toContain("key: 'intents.")
    expect(legacyToolRegistrySource).not.toContain("key: 'exchange_rates.")
    expect(legacyToolRegistrySource).not.toContain("key: 'coverage.")
    expect(legacyToolRegistrySource).not.toContain("key: 'intents.")
  })
})


describe('domain-owned model tool executors', () => {
  it('binds every native FX, Coverage, and Intents manifest to an exact-version domain runtime executor', () => {
    expect(
      FX_V2_RUNTIME.toolExecutors.map(({ key, version }) => key + '@' + version),
    ).toEqual(FX_V2_TOOL_MANIFESTS.map(({ key, version }) => key + '@' + version))

    expect(
      COVERAGE_RUNTIME.toolExecutors.map(({ key, version }) => key + '@' + version),
    ).toEqual(COVERAGE_TOOL_MANIFESTS.map(({ key, version }) => key + '@' + version))

    expect(
      INTENTS_RUNTIME.toolExecutors.map(({ key, version }) => key + '@' + version),
    ).toEqual(INTENTS_TOOL_MANIFESTS.map(({ key, version }) => key + '@' + version))
  })

  it('keeps native tool names and implementation imports out of the central executor registry', () => {
    const source = readFileSync(
      new URL('../../ai/tools/platform/current-executor-registry.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain('CURRENT_BUSINESS_DOMAIN_RUNTIMES')
    expect(source).not.toContain("add('exchange_rates.")
    expect(source).not.toContain("add('coverage.")
    expect(source).not.toContain("add('intents.")
    expect(source).not.toContain('executeFxV2')
    expect(source).not.toContain('executeCoverage')
    expect(source).not.toContain('executeIntents')
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


describe('single business-domain composition root', () => {
  it('derives tool-platform domains and business runtime composition from one catalog', () => {
    const catalog = readFileSync(
      new URL('./domain-catalog.ts', import.meta.url),
      'utf8',
    )
    const toolRegistry = readFileSync(
      new URL('../../ai/tools/platform/current-domain-registry.ts', import.meta.url),
      'utf8',
    )
    const composition = readFileSync(
      new URL('./composition.ts', import.meta.url),
      'utf8',
    )

    expect(catalog).toContain('FX_V2_DOMAIN')
    expect(catalog).toContain('COVERAGE_DOMAIN')
    expect(catalog).toContain('INTENTS_DOMAIN')
    expect(toolRegistry).toContain('CURRENT_BUSINESS_DOMAIN_MODULES')
    expect(toolRegistry).not.toContain('const NATIVE_DOMAINS')
    expect(composition).toContain("from './domain-catalog'")
  })
})


describe('Intents third-domain architectural acceptance', () => {
  const intentEvents = [
    'service_request.approved',
    'service_request.rejected',
    'service_request.matched',
    'service_request.needs_clarification',
    'service_request.completed',
  ] as const

  it('registers a real third domain with tools, deterministic change action, events, templates, and projectors', () => {
    expect(CURRENT_BUSINESS_DOMAIN_REGISTRY.getDomain('intents')).toMatchObject({
      key: INTENTS_DOMAIN.key,
      version: INTENTS_DOMAIN.version,
      title: INTENTS_DOMAIN.title,
    })
    expect(INTENTS_DOMAIN.tools.map((tool) => tool.key)).toEqual([
      'intents.record',
      'intents.search',
      'intents.propose_decision',
    ])
    expect(INTENTS_DOMAIN.changeActions.map((action) => action.key)).toEqual([
      'intents.decision.apply',
    ])
    expect(INTENTS_DOMAIN.events.map((event) => event.key)).toEqual(intentEvents)
    expect(INTENTS_DOMAIN.messageTemplates.map((template) => template.key).sort()).toEqual(
      [...intentEvents].sort(),
    )

    expect(
      CURRENT_BUSINESS_DOMAIN_REGISTRY.resolveLegacyChangeAction({
        targetType: 'service_intent',
        targetId: 'intent-1',
        intent: 'update',
      })?.key,
    ).toBe('intents.decision.apply')
    expect(
      CURRENT_BUSINESS_DOMAIN_REGISTRY.resolveLegacyChangeAction({
        targetType: 'service_intent',
        targetId: 'intent-1',
        intent: 'create',
      })?.key,
    ).toBe('intents.decision.apply')
    expect(CURRENT_CHANGE_EXECUTOR_REGISTRY.has('intents.decision.apply', 1)).toBe(true)

    for (const eventType of intentEvents) {
      expect(
        CURRENT_BUSINESS_DOMAIN_REGISTRY.getEvent(eventType, 1)?.domain,
        eventType,
      ).toBe('intents')
      expect(CURRENT_EVENT_PROJECTOR_REGISTRY.has(eventType, 1), eventType).toBe(true)
    }
  })

  it('removes Intents branches from kernel execution and central registries', () => {
    const changeExecutor = readFileSync(
      new URL('../../ai/runtime/change-request-executor.ts', import.meta.url),
      'utf8',
    )
    const toolRegistry = readFileSync(
      new URL('../../ai/runtime/tool-registry.ts', import.meta.url),
      'utf8',
    )
    const executorRegistry = readFileSync(
      new URL('../../ai/tools/platform/current-executor-registry.ts', import.meta.url),
      'utf8',
    )
    const centralExecutors = readFileSync(
      new URL('../../ai/tools/executors.ts', import.meta.url),
      'utf8',
    )
    const centralHandoff = readFileSync(
      new URL('../../ai/tools/business-handoff.ts', import.meta.url),
      'utf8',
    )

    expect(changeExecutor).toContain('tryExecuteCurrentChangeAction')
    expect(changeExecutor).not.toContain("row.target_type === 'service_intent'")
    expect(toolRegistry).not.toContain("key: 'intents.")
    expect(executorRegistry).not.toContain("add('intents.")
    expect(centralExecutors).not.toContain('executeIntentsRecord')
    expect(centralExecutors).not.toContain('executeIntentsSearch')
    expect(centralHandoff).not.toContain('executeIntentProposeDecision')
  })

  it('keeps the generic runtime/worker/template resolver free of Intents business semantics', () => {
    const dispatch = readFileSync(
      new URL('../../ai/runtime/dispatch.ts', import.meta.url),
      'utf8',
    )
    const worker = readFileSync(
      new URL('../../ai/runtime/worker.ts', import.meta.url),
      'utf8',
    )
    const delivery = readFileSync(
      new URL('../../ai/runtime/customer-notification-delivery.ts', import.meta.url),
      'utf8',
    )
    const resolver = readFileSync(
      new URL('../../messaging/resolver.ts', import.meta.url),
      'utf8',
    )
    expect(dispatch).not.toContain("intents.")
    expect(worker).not.toContain("intents.")
    expect(delivery).not.toContain("intents.")
    expect(delivery).not.toContain("target_type !== 'service_intent'")
    expect(delivery).not.toContain("target_type === 'service_intent'")
    expect(delivery).not.toContain('renderServiceRequestCustomerMessage')
    expect(resolver).not.toContain("intents.")
    expect(delivery).toContain('renderLinkedLegacyBusinessEventNotification')
    expect(delivery).not.toContain('CURRENT_LEGACY_NOTIFICATION_RENDERERS')
  })
})


describe('shared service primitives cleanup', () => {
  it('uses the shared decimal parser for Coverage money validation and removes dead manual arithmetic', () => {
    const coverageHandoff = readFileSync(
      new URL('../../ai/tools/business-handoff.ts', import.meta.url),
      'utf8',
    )
    const coverageExecutors = readFileSync(
      new URL('../../ai/tools/executors.ts', import.meta.url),
      'utf8',
    )
    const fxEngine = readFileSync(
      new URL('../fx-v2/engine.ts', import.meta.url),
      'utf8',
    )

    expect(coverageHandoff).toContain(
      "import { parseDecimal } from '@/lib/services/pricing/decimal'",
    )
    expect(coverageHandoff).toContain(
      'parseDecimal(amount, { rejectZero: true })',
    )
    expect(coverageHandoff).toContain('parseDecimal(rate)')
    expect(coverageHandoff).not.toContain('const parsed = Number(amount)')
    expect(coverageHandoff).not.toContain('const parsed = Number(rate)')
    expect(coverageExecutors).not.toContain('executeCoverageProposeOffer')
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


describe('Coverage legacy change-notification contraction', () => {
  it('uses a generic render-at-delivery marker instead of a Coverage renderer registry', () => {
    const executor = readFileSync(
      new URL('../../ai/runtime/change-request-executor.ts', import.meta.url),
      'utf8',
    )
    const coverageExecutors = readFileSync(
      new URL('../coverage/change-executors.ts', import.meta.url),
      'utf8',
    )

    expect(executor).toContain('BUSINESS_EVENT_RENDER_AT_DELIVERY_MARKER')
    expect(executor).toContain('render_from_business_event?: boolean')
    expect(executor).not.toContain('CURRENT_LEGACY_STRUCTURED_NOTIFICATION_RENDERERS')
    expect(executor).not.toContain('renderCoverageApprovedCustomerMessage')
    expect(executor).not.toContain('coverage.offer.approved')
    expect(executor).not.toContain('coverage.request.approved')

    expect(coverageExecutors).toContain('render_from_business_event: true')
    expect(coverageExecutors).not.toContain('template_event')
    expect(coverageExecutors).not.toContain('template_payload')
    expect(coverageExecutors).not.toContain('CoverageNotificationPayload')
    expect(coverageExecutors).not.toContain('renderCoverageApprovedCustomerMessage')
  })
})

describe('canonical legacy notification fallback contraction', () => {
  it('renders linked rollback rows through the generic Business Event path', () => {
    const runtime = readFileSync(
      new URL('../../ai/runtime/customer-notification-delivery.ts', import.meta.url),
      'utf8',
    )
    const delivery = readFileSync(
      new URL('./business-event-delivery.ts', import.meta.url),
      'utf8',
    )
    const shadowParity = readFileSync(
      new URL('./business-event-outbox.ts', import.meta.url),
      'utf8',
    )

    expect(runtime).toContain('renderLinkedLegacyBusinessEventNotification')
    expect(runtime).not.toContain('CURRENT_LEGACY_NOTIFICATION_RENDERERS')
    expect(runtime).not.toContain('renderServiceRequestCustomerMessage')
    expect(runtime).not.toContain('renderFxTradeBusinessEventText')
    expect(runtime).not.toContain('fx_trade_request_id')
    expect(runtime).not.toContain("target_type === 'service_intent'")

    expect(delivery).toContain('renderLinkedLegacyBusinessEventNotification')
    expect(delivery).toContain('CURRENT_EVENT_PROJECTOR_REGISTRY')
    expect(delivery).toContain('renderBusinessEventProjection')
    expect(delivery).not.toContain('exchange_rate')
    expect(delivery).not.toContain('fx_trade_request')
    expect(delivery).not.toContain('coverage')
    expect(delivery).not.toContain('service_intent')

    expect(shadowParity).toContain('renderLinkedLegacyBusinessEventNotification')
    expect(shadowParity).not.toContain('CURRENT_LEGACY_NOTIFICATION_RENDERERS')
    expect(shadowParity).not.toContain('renderFxTradeBusinessEventText')
    expect(shadowParity).not.toContain('fx_trade_request_id')
  })
})


describe('exact-version runtime tool contraction', () => {
  it('resolves the frozen grant version directly instead of requiring the newest version', () => {
    const dispatch = readFileSync(
      new URL('../../ai/runtime/dispatch.ts', import.meta.url),
      'utf8',
    )
    const loop = readFileSync(
      new URL('../../ai/runtime/agent-loop.ts', import.meta.url),
      'utf8',
    )

    expect(dispatch).toContain(
      'getCurrentPlatformTool(invocation.toolKey, grantedVersion)',
    )
    expect(dispatch).not.toContain('grantedVersion !== latestTool.version')
    expect(loop).toContain('CURRENT_PLATFORM_REGISTRY.modelVisibleTools')
    expect(loop).toContain(
      'getCurrentPlatformTool(call.toolKey, grant.toolVersion)',
    )
    expect(loop).not.toContain('getRegisteredTool(key)')
  })

  it('builds provider tools from native platform manifests, not legacy ToolDefinition', () => {
    const nativeTools = readFileSync(
      new URL('../../ai/runtime/native-agent-tools.ts', import.meta.url),
      'utf8',
    )
    const schema = readFileSync(
      new URL('../../ai/runtime/tool-schema.ts', import.meta.url),
      'utf8',
    )

    expect(nativeTools).toContain('ReadonlyArray<PlatformToolManifest>')
    expect(nativeTools).not.toContain("from './tool-registry'")
    expect(schema).toContain("PlatformToolManifest")
    expect(schema).not.toContain("from './tool-registry'")
  })
})


describe('Services/Pricing Phase 2A native ownership', () => {
  it('registers native domains and deterministic actions without central change branches', () => {
    expect(CURRENT_BUSINESS_DOMAIN_REGISTRY.getDomain('services')?.version).toBe(
      SERVICES_DOMAIN.version,
    )
    expect(CURRENT_BUSINESS_DOMAIN_REGISTRY.getDomain('pricing')?.version).toBe(
      PRICING_DOMAIN.version,
    )
    expect(
      CURRENT_BUSINESS_DOMAIN_REGISTRY.getDomain('pricing_rules')?.version,
    ).toBe(PRICING_RULES_DOMAIN.version)

    expect(
      CURRENT_BUSINESS_DOMAIN_REGISTRY.resolveLegacyChangeAction({
        targetType: 'service',
        targetId: 'service-1',
        intent: 'update',
      })?.key,
    ).toBe('services.update')
    expect(
      CURRENT_BUSINESS_DOMAIN_REGISTRY.resolveLegacyChangeAction({
        targetType: 'pricing_rule',
        targetId: null,
        intent: 'create_and_attach',
      })?.key,
    ).toBe('pricing_rules.create_and_attach')
    expect(
      CURRENT_BUSINESS_DOMAIN_REGISTRY.resolveLegacyChangeAction({
        targetType: 'pricing_rule',
        targetId: 'rule-1',
        intent: 'publish',
      })?.key,
    ).toBe('pricing_rules.publish')

    expect(CURRENT_CHANGE_EXECUTOR_REGISTRY.has('services.update', 1)).toBe(true)
    expect(
      CURRENT_CHANGE_EXECUTOR_REGISTRY.has('pricing_rules.create_and_attach', 1),
    ).toBe(true)
    expect(
      CURRENT_CHANGE_EXECUTOR_REGISTRY.has('pricing_rules.publish', 1),
    ).toBe(true)

    const source = readFileSync(
      new URL('../../ai/runtime/change-request-executor.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toContain("row.target_type === 'service'")
    expect(source).not.toContain("row.target_type === 'pricing_rule'")
    expect(source).not.toContain('apply_service_agent_change')
    expect(source).not.toContain('apply_service_pricing_change')
    expect(source).not.toContain('publishPricingRuleRaw')
  })

  it('registers Services/Pricing model executors through domain runtimes, not the central executor registry', () => {
    expect(
      SERVICES_RUNTIME.toolExecutors.map(({ key, version }) => key + '@' + version),
    ).toEqual(
      SERVICES_TOOL_MANIFESTS.map(({ key, version }) => key + '@' + version),
    )
    expect(
      PRICING_RUNTIME.toolExecutors.map(({ key, version }) => key + '@' + version),
    ).toEqual(
      PRICING_TOOL_MANIFESTS.map(({ key, version }) => key + '@' + version),
    )
    expect(
      PRICING_RULES_RUNTIME.toolExecutors.map(
        ({ key, version }) => key + '@' + version,
      ),
    ).toEqual(
      PRICING_RULES_TOOL_MANIFESTS.map(
        ({ key, version }) => key + '@' + version,
      ),
    )

    const central = readFileSync(
      new URL('../../ai/tools/platform/current-executor-registry.ts', import.meta.url),
      'utf8',
    )
    expect(central).not.toContain("add('services.")
    expect(central).not.toContain("add('pricing.")
    expect(central).not.toContain("add('pricing_rules.")
  })

  it('keeps exact action identity on newly created service/pricing proposals', () => {
    const servicesRuntime = readFileSync(
      new URL('../service-catalog/ai-tool-runtime.ts', import.meta.url),
      'utf8',
    )
    const pricingRulesRuntime = readFileSync(
      new URL('../pricing-rules/ai-tool-runtime.ts', import.meta.url),
      'utf8',
    )
    expect(servicesRuntime).toContain("actionKey: 'services.update'")
    expect(servicesRuntime).toContain('actionVersion: 1')
    expect(pricingRulesRuntime).toContain(
      "actionKey: 'pricing_rules.create_and_attach'",
    )
    expect(pricingRulesRuntime).toContain('actionVersion: 1')
  })
})


describe('Services/Pricing Phase 2B ownership contraction', () => {
  it('contracts all Services/Pricing tool definitions out of the legacy registry', () => {
    const manifests = [
      ...SERVICES_TOOL_MANIFESTS,
      ...PRICING_TOOL_MANIFESTS,
      ...PRICING_RULES_TOOL_MANIFESTS,
    ]
    for (const manifest of manifests) {
      expect(getRegisteredTool(manifest.key), manifest.key).toBeNull()
      expect(getCurrentPlatformTool(manifest.key, manifest.version)).toEqual(
        manifest,
      )
      expect(
        getCurrentToolDefinition(manifest.key, manifest.version),
        manifest.key,
      ).toMatchObject({
        key: manifest.key,
        version: manifest.version,
        description: manifest.description,
      })
    }
  })

  it('owns service read/match/proposal implementations under service-catalog while keeping compatibility exports', () => {
    const runtime = readFileSync(
      new URL('../service-catalog/ai-tool-runtime.ts', import.meta.url),
      'utf8',
    )
    const legacySearch = readFileSync(
      new URL('../../ai/tools/service-search.ts', import.meta.url),
      'utf8',
    )
    const legacyMatcher = readFileSync(
      new URL('../../ai/tools/service-matcher.ts', import.meta.url),
      'utf8',
    )
    const handoff = readFileSync(
      new URL('../../ai/tools/business-handoff.ts', import.meta.url),
      'utf8',
    )

    expect(runtime).toContain('executeServiceProposeUpdate')
    expect(runtime).toContain('matchServiceRequest')
    expect(runtime).toContain('executeServicesSearchSafe')
    expect(legacySearch).toContain(
      "export * from '@/lib/services/service-catalog/read-tools'",
    )
    expect(legacyMatcher).toContain(
      "export * from '@/lib/services/service-catalog/matcher'",
    )
    expect(handoff).toContain(
      "export { executeServiceProposeUpdate } from '@/lib/services/service-catalog/ai-tool-runtime'",
    )
    expect(handoff).toContain(
      "export { executePricingRuleProposeServicePrice } from '@/lib/services/pricing-rules/ai-tool-runtime'",
    )
    expect(handoff).not.toContain(
      'export async function executeServiceProposeUpdate(',
    )
    expect(handoff).not.toContain(
      'export async function executePricingRuleProposeServicePrice(',
    )
  })

  it('owns quote and pricing proposal executors inside their native runtime modules', () => {
    const pricing = readFileSync(
      new URL('../pricing/ai-tool-runtime.ts', import.meta.url),
      'utf8',
    )
    const pricingRules = readFileSync(
      new URL('../pricing-rules/ai-tool-runtime.ts', import.meta.url),
      'utf8',
    )
    expect(pricing).toContain('previewServiceQuote({')
    expect(pricingRules).toContain('calculateQuote(')
    expect(pricingRules).toContain(
      "actionKey: 'pricing_rules.create_and_attach'",
    )
  })
})


describe('Phase 2 generic Change Request kernel purity', () => {
  it('keeps domain current-state/version validation out of the generic executor', () => {
    const kernel = readFileSync(
      new URL('../../ai/runtime/change-request-executor.ts', import.meta.url),
      'utf8',
    )
    const servicesExecutor = readFileSync(
      new URL('../service-catalog/change-executors.ts', import.meta.url),
      'utf8',
    )
    const pricingExecutor = readFileSync(
      new URL('../pricing-rules/change-executors.ts', import.meta.url),
      'utf8',
    )

    expect(kernel).not.toContain('assertExpectedVersion')
    expect(kernel).not.toContain("service: 'services'")
    expect(kernel).not.toContain("ai_agent: 'ai_agents'")
    expect(kernel).not.toContain('EXPECTED_VERSION_UNSUPPORTED')
    expect(kernel).not.toContain('SERVICE_VERSION_CONFLICT')
    expect(kernel).not.toContain('SERVICE_PRICING_VERSION_CONFLICT')

    expect(servicesExecutor).toContain('p_expected_version: change.expectedVersion')
    expect(servicesExecutor).toContain('SERVICE_VERSION_CONFLICT')
    expect(pricingExecutor).toContain('p_expected_service_version')
    expect(pricingExecutor).toContain('SERVICE_PRICING_VERSION_CONFLICT')
  })
})
