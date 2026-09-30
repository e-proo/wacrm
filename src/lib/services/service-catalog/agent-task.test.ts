import { describe, expect, it } from 'vitest'
import { buildAgentTaskPlatform } from '@/lib/ai/tasks/target-resolution'
import {
  SERVICE_PROMOTION_MESSAGE_POLICY,
  SERVICE_PROMOTION_TASK_MODULE,
} from './agent-task'
import { SERVICES_DOMAIN } from './domain'

describe('Service promotion Agent Task', () => {
  it('registers the deterministic promotion task contracts', () => {
    const platform = buildAgentTaskPlatform([SERVICE_PROMOTION_TASK_MODULE])
    const manifest = platform.taskTypes.get('services.promotion', 1)

    expect(manifest).toBeTruthy()
    expect(manifest?.requiredAgentCapabilities).toContain('services.promotion')
    expect(manifest?.requiredTaskApproval).toBe('task')
    expect(manifest?.allowedTools).toEqual([
      { key: 'services.get', version: 1 },
      { key: 'services.match_request', version: 1 },
      { key: 'intents.record', version: 1 },
    ])
    expect(
      platform.targetResolvers.get('services.promotion_audience')?.domain,
    ).toBe('services')
    expect(
      platform.outboundMessagePolicies.get(
        'services.promotion_message',
        1,
      )?.domain,
    ).toBe('services')
    expect(SERVICES_DOMAIN.capabilities).toContain('services.promotion')
  })

  it('uses an approved template candidate with only frozen public service data', async () => {
    const candidate = await SERVICE_PROMOTION_MESSAGE_POLICY.prepare({
      accountId: 'account',
      runId: 'run',
      taskId: 'task',
      taskTargetId: 'target',
      taskType: 'services.promotion',
      taskTypeVersion: 1,
      objective: 'Promote service',
      taskContext: {
        serviceId: '00000000-0000-4000-8000-000000000001',
        service: {
          serviceId: '00000000-0000-4000-8000-000000000001',
          name: 'خدمة تجريبية',
          code: 'TEST',
          publicDescription: 'Public only',
        },
      },
      targetPolicy: {},
      counterpartyRole: 'service_customer',
      policy: {
        key: 'services.promotion_message',
        version: 1,
        config: {
          templateName: 'service_promotion_v1',
          templateLanguage: 'ar',
        },
      },
      modelCandidateText: 'This free text must not be used for initial outreach.',
    })

    expect(candidate).toEqual({
      kind: 'template',
      templateName: 'service_promotion_v1',
      language: 'ar',
      params: ['خدمة تجريبية'],
    })
  })

  it('rejects a non-customer promotion message context', async () => {
    await expect(
      SERVICE_PROMOTION_MESSAGE_POLICY.prepare({
        accountId: 'account',
        runId: 'run',
        taskId: 'task',
        taskTargetId: 'target',
        taskType: 'services.promotion',
        taskTypeVersion: 1,
        objective: 'Promote service',
        taskContext: { service: { name: 'Service' } },
        targetPolicy: {},
        counterpartyRole: 'supplier',
        policy: {
          key: 'services.promotion_message',
          version: 1,
          config: {},
        },
        modelCandidateText: null,
      }),
    ).rejects.toThrow('SERVICE_PROMOTION_MESSAGE_CONTEXT_INVALID')
  })
})
