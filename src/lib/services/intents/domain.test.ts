import { describe, expect, it } from 'vitest'
import { INTENTS_DOMAIN, INTENTS_RUNTIME } from './domain'
import { INTENTS_TOOL_MANIFESTS } from './tool-manifests'
import { INTENT_BUSINESS_EVENT_MANIFESTS } from './business-events'
import { buildIntentBusinessEventProjection } from './message-projectors'

describe('Intents domain contract', () => {
  it('owns its native tools, decision action, canonical events, and projectors', () => {
    expect(INTENTS_DOMAIN.key).toBe('intents')
    expect(INTENTS_DOMAIN.tools).toEqual(INTENTS_TOOL_MANIFESTS)
    expect(INTENTS_DOMAIN.changeActions).toEqual([
      expect.objectContaining({
        key: 'intents.decision.apply',
        approvalRequired: true,
        idempotent: true,
      }),
    ])
    expect(INTENTS_DOMAIN.events).toEqual(INTENT_BUSINESS_EVENT_MANIFESTS)

    expect(INTENTS_RUNTIME.toolExecutors.map(({ key, version }) => `${key}@${version}`)).toEqual(
      INTENTS_TOOL_MANIFESTS.map(({ key, version }) => `${key}@${version}`),
    )
    expect(INTENTS_RUNTIME.changeExecutors.map(({ actionKey }) => actionKey)).toEqual([
      'intents.decision.apply',
    ])
    expect(INTENTS_RUNTIME.eventProjectors.map(({ eventType }) => eventType)).toEqual([
      'service_request.approved',
      'service_request.rejected',
      'service_request.matched',
      'service_request.needs_clarification',
      'service_request.completed',
    ])
  })

  it('keeps customer and admin tool planes explicit', () => {
    expect(
      INTENTS_TOOL_MANIFESTS.find((tool) => tool.key === 'intents.record')?.allowedPlanes,
    ).toEqual(['customer', 'admin'])
    expect(
      INTENTS_TOOL_MANIFESTS.find((tool) => tool.key === 'intents.search')?.allowedPlanes,
    ).toEqual(['admin'])
    expect(
      INTENTS_TOOL_MANIFESTS.find((tool) => tool.key === 'intents.propose_decision')
        ?.allowedPlanes,
    ).toEqual(['admin'])
  })

  it('projects immutable service-request facts without domain arithmetic', () => {
    const projection = buildIntentBusinessEventProjection({
      accountId: 'account-1',
      eventType: 'service_request.matched',
      eventVersion: 1,
      subjectType: 'service_intent',
      subjectId: 'intent-1',
      audience: 'customer',
      channel: 'whatsapp',
      correlationId: 'change-1',
      causationId: 'intent-1',
      payload: {
        service_id: 'service-1',
        service_name: 'تحويل',
        customer_reason: 'مطابقة إدارية',
      },
    })

    expect(projection.eventKey).toBe('service_request.matched')
    expect(projection.context.entity.id).toBe('intent-1')
    expect(projection.context.service?.id).toBe('service-1')
    expect(projection.context.service?.name).toBe('تحويل')
    expect(projection.emergencyText).toContain('ربطه بخدمة')
  })

  it('rejects a non-intent event subject', () => {
    expect(() =>
      buildIntentBusinessEventProjection({
        accountId: 'account-1',
        eventType: 'service_request.approved',
        eventVersion: 1,
        subjectType: 'coverage_request',
        subjectId: 'request-1',
        audience: 'customer',
        channel: 'whatsapp',
        correlationId: null,
        causationId: null,
        payload: {},
      }),
    ).toThrow('SERVICE_REQUEST_EVENT_SUBJECT_MISMATCH')
  })
})
