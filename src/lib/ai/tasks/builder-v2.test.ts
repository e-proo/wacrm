import { describe, expect, it } from 'vitest'
import { defineAgentTaskType } from './contracts'
import { AgentTaskTypeRegistry } from './registry'
import {
  defaultBuilderTaskBinding,
  listBuilderTaskTypes,
  validateBuilderV2Configuration,
} from './builder-v2'

function registry() {
  return new AgentTaskTypeRegistry().register(
    'services',
    defineAgentTaskType({
      key: 'services.promotion',
      version: 1,
      domain: 'services',
      title: 'Service promotion',
      description: 'Offer a registered service to eligible contacts.',
      requiredAgentCapabilities: ['services.promotion'],
      allowedChannels: ['whatsapp'],
      targetResolver: 'services.promotion_candidates',
      allowedTools: [{ key: 'services.get', version: 1 }],
      requiredTaskApproval: 'task',
      followupPolicy: {
        maxFollowups: 2,
        minimumIntervalMinutes: 60,
        maximumIntervalMinutes: 1440,
        stopOnReply: true,
        stopOnOptOut: true,
        stopOnBusinessOutcome: true,
      },
      maxTargets: 100,
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
}

describe('Agent Builder V2 task configuration', () => {
  it('lists only registered Task Types', () => {
    const types = listBuilderTaskTypes(registry())
    expect(types).toHaveLength(1)
    expect(types[0]).toMatchObject({
      key: 'services.promotion',
      version: 1,
      domain: 'services',
      requiredTaskApproval: 'task',
    })
  })

  it('builds bounded defaults from the Task Type manifest', () => {
    const manifest = registry().get('services.promotion', 1)
    expect(manifest).not.toBeNull()
    const binding = defaultBuilderTaskBinding(manifest!)
    expect(binding).toMatchObject({
      taskType: 'services.promotion',
      taskTypeVersion: 1,
      maxTargets: 50,
      maxAttemptsPerTarget: 3,
      maxFollowups: 2,
      cooldownMinutes: 60,
      approvalMode: 'task',
    })
  })

  it('derives the exact outbound + task + tool capabilities', () => {
    const manifest = registry().get('services.promotion', 1)!
    const binding = defaultBuilderTaskBinding(manifest)
    const result = validateBuilderV2Configuration({
      config: { operationalMode: 'outbound', bindings: [binding] },
      registry: registry(),
      revisionToolGrants: [
        {
          toolKey: 'services.get',
          toolVersion: 1,
          permission: 'read',
        },
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.capabilities).toEqual([
      'agent_tasks.read',
      'contacts.target_read',
      'outreach.start',
      'services.promotion',
      'services.read',
    ])
  })

  it('does not derive tool capabilities for grants outside the Task Type scope', () => {
    const manifest = registry().get('services.promotion', 1)!
    const result = validateBuilderV2Configuration({
      config: {
        operationalMode: 'outbound',
        bindings: [defaultBuilderTaskBinding(manifest)],
      },
      registry: registry(),
      revisionToolGrants: [
        {
          toolKey: 'exchange_rates.get_current',
          toolVersion: 1,
          permission: 'read',
        },
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.capabilities).not.toContain('exchange_rates.read')
    expect(result.capabilities).not.toContain('services.read')
  })

  it('blocks outbound mode without a registered Task Type binding', () => {
    expect(
      validateBuilderV2Configuration({
        config: { operationalMode: 'outbound', bindings: [] },
        registry: registry(),
        revisionToolGrants: [],
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'OUTBOUND_TASK_TYPE_REQUIRED' }),
      ]),
    })
  })

  it('blocks outbound bindings on a reactive-only revision', () => {
    const manifest = registry().get('services.promotion', 1)!
    expect(
      validateBuilderV2Configuration({
        config: {
          operationalMode: 'reactive',
          bindings: [defaultBuilderTaskBinding(manifest)],
        },
        registry: registry(),
        revisionToolGrants: [],
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'REACTIVE_TASK_BINDING_FORBIDDEN' }),
      ]),
    })
  })

  it('cannot weaken a Task Type required approval policy', () => {
    const manifest = registry().get('services.promotion', 1)!
    const binding = {
      ...defaultBuilderTaskBinding(manifest),
      approvalMode: 'none' as const,
    }

    expect(
      validateBuilderV2Configuration({
        config: { operationalMode: 'both', bindings: [binding] },
        registry: registry(),
        revisionToolGrants: [],
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'APPROVAL_POLICY_TOO_WEAK' }),
      ]),
    })
  })

  it('blocks unsafe target scope and limits before persistence', () => {
    const manifest = registry().get('services.promotion', 1)!
    const duplicateTag = '00000000-0000-4000-8000-000000000001'
    const binding = {
      ...defaultBuilderTaskBinding(manifest),
      maxTargets: 101,
      targetScope: {
        requiredTagIds: [duplicateTag],
        excludedTagIds: [duplicateTag],
        serviceIds: [],
        regionIds: [],
        domainSelector: null,
      },
      workingHours: {
        enabled: true,
        timezone: 'Asia/Aden',
        weekdays: [0, 7],
        start: '18:00',
        end: '09:00',
      },
    }

    const result = validateBuilderV2Configuration({
      config: { operationalMode: 'outbound', bindings: [binding] },
      registry: registry(),
      revisionToolGrants: [],
    })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'INVALID_MAX_TARGETS',
        'TARGET_SCOPE_TAG_CONFLICT',
        'INVALID_WORKING_HOURS_WEEKDAYS',
        'INVALID_WORKING_HOURS_WINDOW',
      ]),
    )
  })
})
