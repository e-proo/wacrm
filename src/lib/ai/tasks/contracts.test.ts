import { describe, expect, it } from 'vitest'
import {
  AgentTaskTypeRegistry,
  defineAgentTaskType,
  validateAgentTaskTypeManifest,
  type AgentTaskTypeManifest,
} from './index'

function manifest(
  over: Partial<AgentTaskTypeManifest> = {},
): AgentTaskTypeManifest {
  return {
    key: 'coverage.sourcing',
    version: 1,
    domain: 'coverage',
    title: 'Coverage sourcing',
    description: 'Find eligible coverage suppliers for a bounded request.',
    requiredAgentCapabilities: ['coverage.sourcing'],
    allowedChannels: ['whatsapp'],
    targetResolver: 'coverage.supplier_candidates',
    allowedTools: [
      { key: 'coverage.check_availability', version: 1 },
      { key: 'coverage.propose_offer', version: 2 },
    ],
    requiredTaskApproval: 'task',
    followupPolicy: {
      maxFollowups: 2,
      minimumIntervalMinutes: 60,
      maximumIntervalMinutes: 1440,
      stopOnReply: true,
      stopOnOptOut: true,
      stopOnBusinessOutcome: true,
    },
    maxTargets: 10,
    completionPolicy: {
      key: 'coverage.sourcing_completion',
      version: 1,
      config: {},
    },
    messagePolicy: {
      key: 'coverage.sourcing_message',
      version: 1,
      config: {},
    },
    ...over,
  }
}

describe('AgentTaskTypeManifest', () => {
  it('accepts a bounded domain-owned task contract', () => {
    expect(validateAgentTaskTypeManifest(manifest())).toEqual([])
    expect(defineAgentTaskType(manifest()).key).toBe('coverage.sourcing')
  })

  it('rejects cross-domain resolver and policy ownership', () => {
    const issues = validateAgentTaskTypeManifest(
      manifest({
        targetResolver: 'services.customer_segment',
        messagePolicy: { key: 'services.promotion_message', version: 1, config: {} },
      }),
    )
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'TARGET_RESOLVER_DOMAIN_MISMATCH',
        'POLICY_DOMAIN_MISMATCH',
      ]),
    )
  })

  it('rejects duplicate tools and invalid follow-up bounds', () => {
    const issues = validateAgentTaskTypeManifest(
      manifest({
        allowedTools: [
          { key: 'coverage.check_availability', version: 1 },
          { key: 'coverage.check_availability', version: 1 },
        ],
        followupPolicy: {
          ...manifest().followupPolicy,
          minimumIntervalMinutes: 120,
          maximumIntervalMinutes: 60,
        },
      }),
    )
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'DUPLICATE_ALLOWED_TOOL',
        'INVALID_FOLLOWUP_INTERVAL',
      ]),
    )
  })
})

describe('AgentTaskTypeRegistry', () => {
  it('registers unrelated domain task types without kernel branches', () => {
    const registry = new AgentTaskTypeRegistry()
      .register('coverage', manifest())
      .register(
        'services',
        manifest({
          key: 'services.promotion',
          domain: 'services',
          title: 'Service promotion',
          description: 'Offer a service to a bounded eligible audience.',
          requiredAgentCapabilities: ['services.promotion'],
          targetResolver: 'services.promotion_audience',
          allowedTools: [{ key: 'services.search', version: 1 }],
          completionPolicy: {
            key: 'services.promotion_completion',
            version: 1,
            config: {},
          },
          messagePolicy: {
            key: 'services.promotion_message',
            version: 1,
            config: {},
          },
        }),
      )
      .register(
        'future_domain',
        manifest({
          key: 'future_domain.followup',
          domain: 'future_domain',
          title: 'Future follow-up',
          description: 'Proves a third task type needs registration only.',
          requiredAgentCapabilities: ['future_domain.followup'],
          targetResolver: 'future_domain.targets',
          allowedTools: [],
          completionPolicy: {
            key: 'future_domain.completion',
            version: 1,
            config: {},
          },
          messagePolicy: {
            key: 'future_domain.message',
            version: 1,
            config: {},
          },
        }),
      )

    expect(registry.get('coverage.sourcing', 1)?.domain).toBe('coverage')
    expect(registry.get('services.promotion', 1)?.domain).toBe('services')
    expect(registry.get('future_domain.followup', 1)?.domain).toBe(
      'future_domain',
    )
    expect(registry.list()).toHaveLength(3)
  })

  it('rejects registration by a domain that does not own the manifest', () => {
    expect(() =>
      new AgentTaskTypeRegistry().register('services', manifest()),
    ).toThrow(/domain ownership mismatch/)
  })

  it('rejects duplicate exact task versions', () => {
    const registry = new AgentTaskTypeRegistry().register('coverage', manifest())
    expect(() => registry.register('coverage', manifest())).toThrow(
      /Duplicate agent task type/,
    )
  })
})
