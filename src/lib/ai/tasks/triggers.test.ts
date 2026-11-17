import { describe, expect, it } from 'vitest'
import { CURRENT_AGENT_TASK_TRIGGER_REGISTRY } from './current-platform'
import {
  AgentTaskTriggerRegistry,
  normalizeAgentTaskTriggerFiring,
  type AgentTaskTriggerHandler,
} from './triggers'

const handler: AgentTaskTriggerHandler = {
  domain: 'services',
  taskType: 'services.promotion',
  taskTypeVersion: 1,
  validate() {},
  async start() {
    return { taskId: 'task' }
  },
}

describe('Agent Task Trigger Registry', () => {
  it('registers handlers by exact Task Type version', () => {
    const registry = new AgentTaskTriggerRegistry().register(handler)

    expect(registry.get('services.promotion', 1)).toBeTruthy()
    expect(registry.get('services.promotion', 2)).toBeNull()
    expect(registry.list()).toHaveLength(1)
  })

  it('rejects duplicate and cross-domain handlers', () => {
    const registry = new AgentTaskTriggerRegistry().register(handler)
    expect(() => registry.register(handler)).toThrow(
      'AGENT_TASK_TRIGGER_HANDLER_DUPLICATE',
    )

    expect(() =>
      new AgentTaskTriggerRegistry().register({
        ...handler,
        domain: 'coverage',
      }),
    ).toThrow('AGENT_TASK_TRIGGER_HANDLER_DOMAIN_MISMATCH')
  })

  it('normalizes a durable Business Event firing without losing event identity', () => {
    const firing = normalizeAgentTaskTriggerFiring({
      firing_id: 'firing',
      account_id: 'account',
      trigger_id: 'trigger',
      task_type: 'coverage.sourcing',
      task_type_version: 1,
      agent_id: 'agent',
      trigger_kind: 'business_event',
      config: {},
      filters: { subject_type: 'coverage_request' },
      created_by: null,
      source_key: 'event:event-id',
      scheduled_for: null,
      attempts: 1,
      business_event: {
        id: 'event-id',
        event_type: 'coverage.request.approved',
        event_version: 1,
        subject_type: 'coverage_request',
        subject_id: '00000000-0000-4000-8000-000000000001',
        correlation_id: 'corr',
        causation_id: null,
        payload: { source: 'smoke' },
        created_at: '2026-10-02T00:00:00.000Z',
      },
    })

    expect(firing?.sourceKey).toBe('event:event-id')
    expect(firing?.businessEvent?.eventType).toBe('coverage.request.approved')
    expect(firing?.businessEvent?.subjectType).toBe('coverage_request')
  })

  it('reads frozen version and overlap policy from a firing and rejects malformed policy', () => {
    const base = {
      firing_id: 'firing',
      account_id: 'account',
      trigger_id: 'trigger',
      task_type: 'coverage.sourcing',
      task_type_version: 2,
      agent_id: 'agent',
      trigger_kind: 'schedule',
      config: { coverageRequestId: 'test' },
      filters: {},
      source_key: 'schedule:test',
      attempts: 1,
      policy_version: 3,
      overlap_policy: 'defer',
      approved_revision_id: 'revision-1',
    }
    expect(normalizeAgentTaskTriggerFiring(base)).toMatchObject({
      policyVersion: 3,
      overlapPolicy: 'defer',
      approvedRevisionId: 'revision-1',
    })
    expect(normalizeAgentTaskTriggerFiring({ ...base, overlap_policy: 'retry_forever' })).toBeNull()
    expect(normalizeAgentTaskTriggerFiring({ ...base, policy_version: 0 })).toBeNull()
  })

  it('fails closed when a Business Event firing has no event snapshot', () => {
    expect(
      normalizeAgentTaskTriggerFiring({
        firing_id: 'firing',
        account_id: 'account',
        trigger_id: 'trigger',
        task_type: 'coverage.sourcing',
        task_type_version: 1,
        agent_id: 'agent',
        trigger_kind: 'business_event',
        config: {},
        filters: {},
        source_key: 'event:event-id',
        attempts: 1,
        business_event: null,
      }),
    ).toBeNull()
  })
  it('registers current Coverage and Services trigger handlers without kernel branching', () => {
    const coverage = CURRENT_AGENT_TASK_TRIGGER_REGISTRY.get(
      'coverage.sourcing',
      1,
    )
    const legacyPromotion = CURRENT_AGENT_TASK_TRIGGER_REGISTRY.get(
      'services.promotion',
      1,
    )
    const promotion = CURRENT_AGENT_TASK_TRIGGER_REGISTRY.get(
      'services.promotion',
      2,
    )

    expect(coverage?.domain).toBe('coverage')
    expect(promotion?.domain).toBe('services')
    expect(legacyPromotion?.taskTypeVersion).toBe(1)

    expect(() =>
      coverage?.validate({
        accountId: 'account',
        taskType: 'coverage.sourcing',
        taskTypeVersion: 1,
        agentId: 'agent',
        triggerKind: 'business_event',
        eventType: 'coverage.request.approved',
        eventVersion: 1,
        config: { coverageRequestId: '00000000-0000-4000-8000-000000000002' },
        filters: { subject_type: 'coverage_request',
          subject_id: '00000000-0000-4000-8000-000000000002' },
        idempotencyKey: 'coverage-trigger-test-0001',
        createdBy: null,
      }),
    ).not.toThrow()

    expect(() =>
      promotion?.validate({
        accountId: 'account',
        taskType: 'services.promotion',
        taskTypeVersion: 2,
        agentId: 'agent',
        triggerKind: 'schedule',
        scheduleKind: 'recurring',
        nextFireAt: '2026-10-03T00:00:00.000Z',
        intervalMinutes: 1440,
        config: {
          serviceId: '00000000-0000-4000-8000-000000000001',
          connectionId: '00000000-0000-4000-8000-000000000003',
          promotionReview: { schemaVersion: 1 },
        },
        filters: {},
        idempotencyKey: 'promotion-trigger-test-0001',
        createdBy: null,
      }),
    ).not.toThrow()
    expect(() => legacyPromotion?.validate({
      accountId: 'account',taskType: 'services.promotion',taskTypeVersion: 1,
      agentId: 'agent',triggerKind: 'schedule',
      config: { serviceId: '00000000-0000-4000-8000-000000000001' },
      filters: {},idempotencyKey:'promotion-trigger-test-0002',createdBy:null,
    })).toThrow('SERVICE_PROMOTION_V1_SCHEDULING_DISABLED')
  })

})
