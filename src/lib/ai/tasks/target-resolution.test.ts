import { describe, expect, it } from 'vitest'
import {
  AgentTaskTargetResolverRegistry,
  buildAgentTaskPlatform,
  parseAgentTaskEligibilityPolicy,
  type AgentTaskModule,
  type AgentTaskTargetResolver,
} from './target-resolution'
import { defineAgentTaskType } from './contracts'

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
            config: {},
          },
          messagePolicy: {
            key: 'coverage.sourcing_message',
            config: {},
          },
        }),
      ],
      targetResolvers: [
        noopResolver('coverage.supplier_candidates', 'coverage'),
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
            config: {},
          },
          messagePolicy: {
            key: 'coverage.sourcing_message',
            config: {},
          },
        }),
      ],
      targetResolvers: [],
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
