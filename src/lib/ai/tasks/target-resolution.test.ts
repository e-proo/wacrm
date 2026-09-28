import { describe, expect, it } from 'vitest'
import {
  AgentTaskTargetResolverRegistry,
  buildAgentTaskPlatform,
  parseAgentTaskEligibilityPolicy,
  type AgentTaskModule,
  type AgentTaskTargetResolver,
} from './target-resolution'
import { defineAgentTaskType } from './contracts'
import type { AgentTaskOutboundMessagePolicy } from './outbound-policy'
import type { AgentTaskCompletionPolicy } from './completion-policy'

const noopResolver = (
  key: string,
  domain: string,
): AgentTaskTargetResolver => ({
  key,
  version: 1,
  domain,
  async resolve() {
    return []
  },
})

const noopOutboundPolicy = (
  key: string,
  domain: string,
): AgentTaskOutboundMessagePolicy => ({
  key,
  version: 1,
  domain,
  async prepare() {
    return { kind: 'text', text: 'hello' }
  },
})

const noopCompletionPolicy = (
  key: string,
  domain: string,
): AgentTaskCompletionPolicy => ({
  key,
  version: 1,
  domain,
  async evaluate() {
    return { status: 'continue', reason: 'test' }
  },
})

describe('Target resolver registry', () => {
  it('binds task types to same-domain resolvers without kernel branches', () => {
    const taskModule: AgentTaskModule = {
      domain: 'coverage',
      taskTypes: [
        defineAgentTaskType({
          key: 'coverage.sourcing',
          version: 1,
          domain: 'coverage',
          title: 'Coverage sourcing',
          description: 'Find bounded supplier candidates.',
          requiredAgentCapabilities: ['coverage.sourcing'],
          allowedChannels: ['whatsapp'],
          targetResolver: 'coverage.supplier_candidates',
          allowedTools: [],
          requiredTaskApproval: 'task',
          followupPolicy: {
            maxFollowups: 1,
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
        }),
      ],
      targetResolvers: [
        noopResolver('coverage.supplier_candidates', 'coverage'),
      ],
      outboundMessagePolicies: [
        noopOutboundPolicy('coverage.sourcing_message', 'coverage'),
      ],
      completionPolicies: [
        noopCompletionPolicy('coverage.sourcing_completion', 'coverage'),
      ],
    }

    const platform = buildAgentTaskPlatform([taskModule])
    expect(platform.taskTypes.get('coverage.sourcing', 1)?.domain).toBe(
      'coverage',
    )
    expect(
      platform.targetResolvers.get('coverage.supplier_candidates')?.domain,
    ).toBe('coverage')
  })

  it('rejects a task type whose resolver is not registered', () => {
    const taskModule: AgentTaskModule = {
      domain: 'coverage',
      taskTypes: [
        defineAgentTaskType({
          key: 'coverage.sourcing',
          version: 1,
          domain: 'coverage',
          title: 'Coverage sourcing',
          description: 'Find bounded supplier candidates.',
          requiredAgentCapabilities: ['coverage.sourcing'],
          allowedChannels: ['whatsapp'],
          targetResolver: 'coverage.supplier_candidates',
          allowedTools: [],
          requiredTaskApproval: 'task',
          followupPolicy: {
            maxFollowups: 0,
            minimumIntervalMinutes: 0,
            maximumIntervalMinutes: 0,
            stopOnReply: true,
            stopOnOptOut: true,
            stopOnBusinessOutcome: true,
          },
          maxTargets: 1,
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
        }),
      ],
      targetResolvers: [],
      outboundMessagePolicies: [
        noopOutboundPolicy('coverage.sourcing_message', 'coverage'),
      ],
      completionPolicies: [
        noopCompletionPolicy('coverage.sourcing_completion', 'coverage'),
      ],
    }

    expect(() => buildAgentTaskPlatform([taskModule])).toThrow(
      /unregistered target resolver/,
    )
  })

  it('rejects cross-domain resolver ownership', () => {
    expect(() =>
      new AgentTaskTargetResolverRegistry().register(
        'services',
        noopResolver('coverage.supplier_candidates', 'coverage'),
      ),
    ).toThrow(/domain ownership mismatch/)
  })


  it('rejects task tool scopes that are not customer-plane model tools', () => {
    const taskModule: AgentTaskModule = {
      domain: 'coverage',
      taskTypes: [
        defineAgentTaskType({
          key: 'coverage.sourcing',
          version: 1,
          domain: 'coverage',
          title: 'Coverage sourcing',
          description: 'Find bounded supplier candidates.',
          requiredAgentCapabilities: ['coverage.sourcing'],
          allowedChannels: ['whatsapp'],
          targetResolver: 'coverage.supplier_candidates',
          allowedTools: [
            { key: 'coverage.admin_list_offers', version: 1 },
          ],
          requiredTaskApproval: 'task',
          followupPolicy: {
            maxFollowups: 0,
            minimumIntervalMinutes: 0,
            maximumIntervalMinutes: 0,
            stopOnReply: true,
            stopOnOptOut: true,
            stopOnBusinessOutcome: true,
          },
          maxTargets: 1,
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
        }),
      ],
      targetResolvers: [
        noopResolver('coverage.supplier_candidates', 'coverage'),
      ],
      outboundMessagePolicies: [
        noopOutboundPolicy('coverage.sourcing_message', 'coverage'),
      ],
      completionPolicies: [
        noopCompletionPolicy('coverage.sourcing_completion', 'coverage'),
      ],
    }

    expect(() => buildAgentTaskPlatform([taskModule])).toThrow(
      /TASK_TOOL_CUSTOMER_PLANE_DENIED/,
    )
  })

  it('rejects a task type whose outbound policy is not registered', () => {
    const taskModule: AgentTaskModule = {
      domain: 'coverage',
      taskTypes: [
        defineAgentTaskType({
          key: 'coverage.sourcing',
          version: 1,
          domain: 'coverage',
          title: 'Coverage sourcing',
          description: 'Find bounded supplier candidates.',
          requiredAgentCapabilities: ['coverage.sourcing'],
          allowedChannels: ['whatsapp'],
          targetResolver: 'coverage.supplier_candidates',
          allowedTools: [],
          requiredTaskApproval: 'task',
          followupPolicy: {
            maxFollowups: 1,
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
        }),
      ],
      targetResolvers: [
        noopResolver('coverage.supplier_candidates', 'coverage'),
      ],
      outboundMessagePolicies: [],
      completionPolicies: [
        noopCompletionPolicy('coverage.sourcing_completion', 'coverage'),
      ],
    }

    expect(() => buildAgentTaskPlatform([taskModule])).toThrow(
      /unregistered outbound message policy/,
    )
  })
})

describe('Target eligibility policy', () => {
  it('requires explicit bounded outreach limits', () => {
    expect(() => parseAgentTaskEligibilityPolicy({})).toThrow(
      /MAXNEWCONTACTSPERHOUR/,
    )
  })

  it('normalizes valid deterministic segment policy', () => {
    const tag =
      '00000000-0000-4000-8000-000000000111'
    expect(
      parseAgentTaskEligibilityPolicy({
        requiredTagIds: [tag, tag],
        excludedTagIds: [],
        maxNewContactsPerHour: 20,
        maxContactsPerAgentPerDay: 100,
        cooldownMinutes: 60,
      }),
    ).toEqual({
      requiredTagIds: [tag],
      excludedTagIds: [],
      maxNewContactsPerHour: 20,
      maxContactsPerAgentPerDay: 100,
      cooldownMinutes: 60,
    })
  })

  it('rejects conflicting required/excluded segments', () => {
    const tag =
      '00000000-0000-4000-8000-000000000111'
    expect(() =>
      parseAgentTaskEligibilityPolicy({
        requiredTagIds: [tag],
        excludedTagIds: [tag],
        maxNewContactsPerHour: 20,
        maxContactsPerAgentPerDay: 100,
        cooldownMinutes: 60,
      }),
    ).toThrow(/TAG_FILTER_CONFLICT/)
  })
})
