import {
  buildCoverageMessageContext,
  coverageMethodLabel,
  formatMessageNumber,
} from '@/lib/messaging/domains'
import { normalizeCoverageAttributes } from './attributes'
import type {
  BusinessEventMessageProjection,
  BusinessEventProjectionInput,
  EventProjectorRegistration,
} from '@/lib/services/platform/event-projector-registry'

const COVERAGE_REQUIRED_PLACEHOLDERS = [
  '{{money.amount}}',
  '{{money.currency}}',
] as const

function stringValue(
  value: unknown,
  code: string,
  options?: { optional?: boolean },
): string | null {
  if (value == null || value === '') {
    if (options?.optional) return null
    throw new Error(code)
  }
  if (typeof value !== 'string') throw new Error(code)
  return value
}

function scalarValue(
  value: unknown,
  code: string,
): string | number | null {
  if (value == null || value === '') return null
  if (typeof value === 'string' || typeof value === 'number') return value
  throw new Error(code)
}

function recordValue(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(code)
  }
  return value as Record<string, unknown>
}

export function buildCoverageApprovedBusinessEventProjection(
  input: BusinessEventProjectionInput,
): BusinessEventMessageProjection {
  const kind =
    input.eventType === 'coverage.offer.approved'
      ? 'offer'
      : input.eventType === 'coverage.request.approved'
        ? 'request'
        : null

  if (!kind) throw new Error('COVERAGE_EVENT_PROJECTOR_UNSUPPORTED')
  const expectedSubject = kind === 'offer' ? 'coverage_offer' : 'coverage_request'
  if (input.subjectType !== expectedSubject) {
    throw new Error('COVERAGE_EVENT_SUBJECT_MISMATCH')
  }

  const amount = stringValue(input.payload.amount, 'COVERAGE_EVENT_AMOUNT_MISSING')!
  const currency = stringValue(input.payload.currency, 'COVERAGE_EVENT_CURRENCY_MISSING')!
  const payRegion = stringValue(
    input.payload.pay_region_label,
    'COVERAGE_EVENT_PAY_REGION_LABEL_MISSING',
  )!
  const receiveRegion = stringValue(
    input.payload.receive_region_label,
    'COVERAGE_EVENT_RECEIVE_REGION_LABEL_MISSING',
  )!
  const attributesRaw = recordValue(
    input.payload.attributes,
    'COVERAGE_EVENT_ATTRIBUTES_MISSING',
  )
  const attributes = normalizeCoverageAttributes(attributesRaw)
  if (!attributes.ok) {
    throw new Error('COVERAGE_EVENT_ATTRIBUTES_INVALID')
  }

  const commissionAmount = scalarValue(
    input.payload.commission_amount,
    'COVERAGE_EVENT_COMMISSION_INVALID',
  )
  const commissionCurrency =
    stringValue(
      input.payload.commission_currency,
      'COVERAGE_EVENT_COMMISSION_CURRENCY_INVALID',
      { optional: true },
    ) ?? currency
  const reference = stringValue(
    input.payload.reference,
    'COVERAGE_EVENT_REFERENCE_INVALID',
    { optional: true },
  )
  const serviceId = stringValue(
    input.payload.service_id,
    'COVERAGE_EVENT_SERVICE_INVALID',
    { optional: true },
  )

  const commissionEffect =
    kind === 'offer' ? 'customer_receives' : 'customer_pays'

  const context = buildCoverageMessageContext({
    entityType: expectedSubject,
    entityId: input.subjectId,
    reference,
    serviceId,
    amount,
    currency,
    payRegion,
    payMethod: coverageMethodLabel(attributes.normalized.pay_method),
    receiveRegion,
    receiveMethod: coverageMethodLabel(attributes.normalized.receive_method),
    commissionAmount,
    commissionCurrency,
    commissionEffect,
  })

  const referenceLine = reference
    ? '\n' + (kind === 'offer' ? 'رقم العرض' : 'رقم الطلب') + ': ' + reference
    : ''
  const commissionLine =
    commissionAmount != null
      ? '\n' +
        (kind === 'offer' ? 'الراجع لك' : 'العمولة عليك') +
        ': ' +
        formatMessageNumber(commissionAmount) +
        ' ' +
        commissionCurrency
      : ''

  return {
    eventKey: input.eventType,
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    context,
    templatePolicy: {
      forbidSecrets: true,
      requiredBodyPlaceholders: COVERAGE_REQUIRED_PLACEHOLDERS,
    },
    emergencyText:
      (kind === 'offer'
        ? '✅ تم اعتماد عرض التغطية الخاص بك.'
        : '✅ تم اعتماد طلب التغطية الخاص بك.') +
      referenceLine +
      '\nالمبلغ: ' +
      formatMessageNumber(amount) +
      ' ' +
      currency +
      commissionLine,
  }
}

const approvedProjector = async (
  input: BusinessEventProjectionInput,
): Promise<BusinessEventMessageProjection> =>
  buildCoverageApprovedBusinessEventProjection(input)

export const COVERAGE_EVENT_PROJECTORS: readonly EventProjectorRegistration[] = [
  {
    eventType: 'coverage.offer.approved',
    eventVersion: 1,
    projector: approvedProjector,
  },
  {
    eventType: 'coverage.request.approved',
    eventVersion: 1,
    projector: approvedProjector,
  },
]
