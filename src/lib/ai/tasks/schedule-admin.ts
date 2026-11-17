import type { AgentTaskTriggerDefinition } from './triggers'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export class ScheduleValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ScheduleValidationError'
  }
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** Admin input is a narrow typed intent; never accept arbitrary JSON policy, credentials,
 * target lists or selected provider identity from the browser. Every scope is rechecked
 * by the API against ctx.accountId before the service-role create RPC.
 */
export function parseScheduleDraft(raw: unknown, nowMs = Date.now()): {
  definition: AgentTaskTriggerDefinition
  overlapPolicy: 'skip' | 'defer'
  subjectId: string | null
} {
  if (!record(raw) || !uuid(raw.agentId) || !uuid(raw.submissionId)) {
    throw new ScheduleValidationError('SCHEDULE_INPUT_INVALID', 'معرّف الوكيل أو الطلب غير صالح.')
  }
  const overlapPolicy = raw.overlapPolicy
  if (overlapPolicy !== 'skip' && overlapPolicy !== 'defer') {
    throw new ScheduleValidationError('SCHEDULE_OVERLAP_INVALID', 'اختر سياسة تداخل صالحة.')
  }

  const taskType = raw.taskType
  const version = raw.taskTypeVersion
  const coverage = taskType === 'coverage.sourcing' && (version === 1 || version === 2)
  const promotion = taskType === 'services.promotion' && version === 1
  if (!coverage && !promotion) {
    throw new ScheduleValidationError('SCHEDULE_TASK_TYPE_INVALID', 'نوع المهمة أو الإصدار غير مدعوم.')
  }

  let config: Record<string, unknown> = {}
  let filters: Record<string, unknown> = {}
  let scheduleKind: 'once' | 'recurring' | null = null
  let nextFireAt: string | null = null
  let intervalMinutes: number | null = null
  let eventType: string | null = null
  let eventVersion: number | null = null
  let subjectId: string | null = null

  if (raw.triggerKind === 'schedule') {
    if (raw.scheduleKind !== 'once' && raw.scheduleKind !== 'recurring') {
      throw new ScheduleValidationError('SCHEDULE_KIND_INVALID', 'نوع الجدولة غير صالح.')
    }
    scheduleKind = raw.scheduleKind
    if (typeof raw.nextFireAt !== 'string' || !Number.isFinite(Date.parse(raw.nextFireAt))) {
      throw new ScheduleValidationError('SCHEDULE_TIME_INVALID', 'حدد موعد تشغيل صحيح.')
    }
    const start = Date.parse(raw.nextFireAt)
    if (start < nowMs + 60_000 || start > nowMs + 366 * 24 * 3600_000) {
      throw new ScheduleValidationError('SCHEDULE_TIME_OUT_OF_RANGE', 'اختر موعدًا بين دقيقة وسنة من الآن.')
    }
    nextFireAt = new Date(start).toISOString()
    if (scheduleKind === 'recurring') {
      if (typeof raw.intervalMinutes !== 'number' ||
          !Number.isInteger(raw.intervalMinutes) ||
          raw.intervalMinutes < 5 || raw.intervalMinutes > 525600) {
        throw new ScheduleValidationError('SCHEDULE_INTERVAL_INVALID', 'الفاصل يجب أن يكون بين 5 و525600 دقيقة.')
      }
      intervalMinutes = raw.intervalMinutes
    }
    if (coverage && uuid(raw.coverageRequestId)) config = { coverageRequestId: raw.coverageRequestId }
    else if (promotion && uuid(raw.serviceId)) config = { serviceId: raw.serviceId }
    else throw new ScheduleValidationError('SCHEDULE_SUBJECT_INVALID', 'اختر مصدر مهمة صالحًا.')
  } else if (raw.triggerKind === 'business_event') {
    if (!coverage ||
        (raw.eventType !== 'coverage.request.approved' &&
         raw.eventType !== 'coverage.request.activated') ||
        !uuid(raw.coverageRequestId)) {
      throw new ScheduleValidationError('SCHEDULE_EVENT_INVALID', 'حدث الأعمال أو مصدره غير مدعوم.')
    }
    eventType = raw.eventType
    eventVersion = 1
    subjectId = raw.coverageRequestId
    filters = { subject_type: 'coverage_request', subject_id: subjectId }
  } else {
    throw new ScheduleValidationError('SCHEDULE_TRIGGER_KIND_INVALID', 'حدد جدولًا أو حدث أعمال مدعومًا.')
  }

  return {
    overlapPolicy,
    subjectId,
    definition: {
      accountId: '', // replaced by authorized ctx.accountId on the server
      agentId: raw.agentId,
      taskType: taskType as string,
      taskTypeVersion: version as number,
      triggerKind: raw.triggerKind,
      scheduleKind,
      nextFireAt,
      intervalMinutes,
      eventType,
      eventVersion,
      config,
      filters,
      idempotencyKey: 'sch2:' + raw.submissionId,
      createdBy: null, // always server-authorized ctx.userId
    },
  }
}

export function schedulePreview(
  draft: ReturnType<typeof parseScheduleDraft>,
  nowMs = Date.now(),
): { mode: string; nextFireAt: string | null; intervalMinutes: number | null; notice: string } {
  const d = draft.definition
  return {
    mode: d.triggerKind,
    nextFireAt: d.nextFireAt ?? null,
    intervalMinutes: d.intervalMinutes ?? null,
    notice: d.triggerKind === 'business_event'
      ? 'لا ينشئ المعاينة أي مهمة. الحدث المعتمد وحده يفعّل القاعدة بعد تمكينها.'
      : d.nextFireAt && Date.parse(d.nextFireAt) > nowMs
        ? 'معاينة فقط؛ سيتم حفظ القاعدة موقوفة افتراضيًا حتى اعتماد تشغيلها.'
        : 'تحقق من موعد الجدولة.',
  }
}

/** Strict edit of timing/overlap only; source, agent, reviewed revision and
 * business-event filters remain immutable until cancel-and-recreate.
 */
export function parseSchedulePolicyEdit(value: unknown, nowMs=Date.now()): {
 expectedPolicyVersion: number
 scheduleKind: 'once' | 'recurring' | null
 nextFireAt: string | null
 intervalMinutes: number | null
 overlapPolicy: 'skip' | 'defer'
} {
 if (!record(value) || !Number.isInteger(value.expectedPolicyVersion) ||
   Number(value.expectedPolicyVersion)<1) throw new ScheduleValidationError(
   'SCHEDULE_EDIT_VERSION_INVALID','تحتاج إلى تحديث نسخة السياسة.')
 if (value.overlapPolicy!=='skip' && value.overlapPolicy!=='defer')
   throw new ScheduleValidationError('SCHEDULE_OVERLAP_INVALID','سياسة التداخل غير صالحة.')
 const result = {expectedPolicyVersion: value.expectedPolicyVersion as number,
   overlapPolicy: value.overlapPolicy as 'skip'|'defer'}
 if (value.scheduleKind===null && value.nextFireAt==null && value.intervalMinutes==null)
   return {...result,scheduleKind:null,nextFireAt:null,intervalMinutes:null}
 if (value.scheduleKind!=='once' && value.scheduleKind!=='recurring')
   throw new ScheduleValidationError('SCHEDULE_EDIT_KIND_INVALID','نوع الجدولة غير صالح.')
 const at = typeof value.nextFireAt==='string'?Date.parse(value.nextFireAt):Number.NaN
 if (!Number.isFinite(at)||at<=nowMs+60_000||at>nowMs+366*86400000)
   throw new ScheduleValidationError('SCHEDULE_EDIT_TIME_INVALID','اختر موعدًا قادمًا بين دقيقة وسنة.')
 if (value.scheduleKind==='once' && value.intervalMinutes!=null)
   throw new ScheduleValidationError('SCHEDULE_EDIT_INTERVAL_INVALID','الموعد الواحد لا يقبل تكرارًا.')
 if (value.scheduleKind==='recurring' &&
   (typeof value.intervalMinutes!=='number'||!Number.isInteger(value.intervalMinutes)||
     value.intervalMinutes<5||value.intervalMinutes>525600))
   throw new ScheduleValidationError('SCHEDULE_EDIT_INTERVAL_INVALID','الفاصل بين 5 و525600 دقيقة.')
 return {...result,scheduleKind:value.scheduleKind,nextFireAt:new Date(at).toISOString(),
   intervalMinutes:value.scheduleKind==='recurring'?value.intervalMinutes as number:null}
}
