import { buildGenericServiceMessageContext } from '@/lib/messaging/domains'
import type {
  BusinessEventMessageProjection,
  BusinessEventProjectionInput,
  EventProjectorRegistration,
} from './event-projector-registry'
import type { GenericServiceRequestEventType } from './generic-business-events'

const OUTCOME_BY_EVENT = {
  'service_request.approved': 'approved',
  'service_request.rejected': 'rejected',
  'service_request.matched': 'matched',
  'service_request.needs_clarification': 'needs_clarification',
  'service_request.completed': 'completed',
} as const

type ServiceRequestOutcome = (typeof OUTCOME_BY_EVENT)[GenericServiceRequestEventType]

function optionalString(value: unknown, code: string): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw new Error(code)
  return value.trim() || null
}

function emergencyCopy(outcome: ServiceRequestOutcome): string {
  switch (outcome) {
    case 'rejected':
      return 'تمت مراجعة طلبك ولم يتم اعتماده.'
    case 'matched':
      return 'تمت مراجعة طلبك وربطه بخدمة متوفرة لدينا.'
    case 'needs_clarification':
      return 'تمت مراجعة طلبك ونحتاج إلى معلومات إضافية قبل إكماله.'
    case 'completed':
      return '✅ تم إكمال طلبك بنجاح.'
    case 'approved':
    default:
      return '✅ تم اعتماد طلبك بنجاح.'
  }
}

export function buildGenericServiceRequestProjection(
  input: BusinessEventProjectionInput,
): BusinessEventMessageProjection {
  if (!(input.eventType in OUTCOME_BY_EVENT)) {
    throw new Error('SERVICE_REQUEST_EVENT_PROJECTOR_UNSUPPORTED')
  }
  if (input.subjectType !== 'service_intent') {
    throw new Error('SERVICE_REQUEST_EVENT_SUBJECT_MISMATCH')
  }

  const eventType = input.eventType as GenericServiceRequestEventType
  const outcome = OUTCOME_BY_EVENT[eventType]
  const serviceId = optionalString(
    input.payload.service_id,
    'SERVICE_REQUEST_EVENT_SERVICE_ID_INVALID',
  )
  const serviceName = optionalString(
    input.payload.service_name,
    'SERVICE_REQUEST_EVENT_SERVICE_NAME_INVALID',
  )
  const customerReason = optionalString(
    input.payload.customer_reason,
    'SERVICE_REQUEST_EVENT_CUSTOMER_REASON_INVALID',
  )
  const reference = optionalString(
    input.payload.reference,
    'SERVICE_REQUEST_EVENT_REFERENCE_INVALID',
  )
  const summary = optionalString(
    input.payload.summary,
    'SERVICE_REQUEST_EVENT_SUMMARY_INVALID',
  )

  return {
    eventKey: eventType,
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    context: buildGenericServiceMessageContext({
      entityType: 'service_request',
      entityId: input.subjectId,
      reference,
      status: outcome,
      serviceId,
      serviceName,
      summary,
      data: {
        ...(customerReason ? { customer_reason: customerReason } : {}),
      },
    }),
    templatePolicy: {
      forbidSecrets: true,
    },
    emergencyText: emergencyCopy(outcome),
  }
}

const projector = async (
  input: BusinessEventProjectionInput,
): Promise<BusinessEventMessageProjection> =>
  buildGenericServiceRequestProjection(input)

export const PLATFORM_GENERIC_EVENT_PROJECTORS: readonly EventProjectorRegistration[] = (
  Object.keys(OUTCOME_BY_EVENT) as GenericServiceRequestEventType[]
).map((eventType) => ({
  eventType,
  eventVersion: 1,
  projector,
}))
