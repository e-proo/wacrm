import { describe, expect, it } from 'vitest'
import { parseScheduleDraft, schedulePreview, ScheduleValidationError } from './schedule-admin'

const now = Date.parse('2026-11-17T19:00:00.000Z')
const valid = {
  agentId: '00000000-0000-4000-8000-000000000001',
  submissionId: '00000000-0000-4000-8000-000000000002',
  coverageRequestId: '00000000-0000-4000-8000-000000000003',
  taskType: 'coverage.sourcing',
  taskTypeVersion: 2,
  whatsappConnectionId: '88888888-8888-4888-8888-888888888888',
  selectedContactIds: [],
  triggerKind: 'schedule',
  scheduleKind: 'recurring',
  nextFireAt: '2026-11-17T20:00:00.000Z',
  intervalMinutes: 60,
  overlapPolicy: 'skip',
}

describe('SCH-2 typed admin schedule draft', () => {
  it('produces a bounded, server-scopable recurring schedule', () => {
    const parsed = parseScheduleDraft(valid, now)
    expect(parsed.definition).toMatchObject({
      accountId: '',
      taskType: 'coverage.sourcing',
      taskTypeVersion: 2,
      scheduleKind: 'recurring',
      intervalMinutes: 60,
      config: { coverageRequestId: valid.coverageRequestId },
      idempotencyKey: 'sch2:' + valid.submissionId,
    })
    expect(schedulePreview(parsed, now).notice).toContain('معاينة فقط')
  })

  it('accepts only allowlisted account-scoped Coverage business events', () => {
    const input = {
      ...valid, triggerKind: 'business_event', eventType: 'coverage.request.activated',
      scheduleKind: undefined, nextFireAt: undefined, intervalMinutes: undefined,
    }
    expect(parseScheduleDraft(input, now).definition).toMatchObject({
      triggerKind: 'business_event',
      eventVersion: 1,
      filters: { subject_type: 'coverage_request', subject_id: valid.coverageRequestId },
      config: {},
    })
    expect(() => parseScheduleDraft({ ...input, eventType: 'service.lead.created' }, now))
      .toThrow(ScheduleValidationError)
    expect(() => parseScheduleDraft({ ...input, taskType: 'services.promotion' }, now))
      .toThrow(ScheduleValidationError)
  })

  it('rejects unbounded scans, invalid time, and invalid recurrence', () => {
    expect(() => parseScheduleDraft({ ...valid, coverageRequestId: 'all' }, now))
      .toThrow('اختر مصدر مهمة صالحًا')
    expect(() => parseScheduleDraft({ ...valid, nextFireAt: '2026-11-17T18:00:00Z' }, now))
      .toThrow('اختر موعدًا')
    expect(() => parseScheduleDraft({ ...valid, intervalMinutes: 0 }, now))
      .toThrow('الفاصل يجب')
    expect(() => parseScheduleDraft({ ...valid, overlapPolicy: 'retry' }, now))
      .toThrow('اختر سياسة')
    expect(() => parseScheduleDraft({ ...valid, submissionId: 'x' }, now))
      .toThrow(ScheduleValidationError)
  })
})
