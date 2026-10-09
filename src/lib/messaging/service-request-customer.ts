import { buildGenericServiceMessageContext } from './domains'
import { findSystemMessageTemplate } from './defaults'
import { renderMessageTemplate } from './renderer'
import { resolveMessageTemplate } from './resolver'
import type { MessageTemplateDefinition, TemplateOverrideStore } from './types'

export type ServiceRequestCustomerOutcome =
  | 'approved'
  | 'rejected'
  | 'matched'
  | 'needs_clarification'
  | 'completed'

export interface ServiceRequestCustomerMessageInput {
  accountId: string
  outcome: ServiceRequestCustomerOutcome
  entityId?: string | null
  reference?: string | null
  serviceId?: string | null
  serviceName?: string | null
  summary?: string | null
  customerReason?: string | null
  locale?: string | null
  store?: TemplateOverrideStore | null
}

export interface RenderedServiceRequestCustomerMessage {
  text: string
  source: 'account' | 'system' | 'emergency'
  eventKey: string
  resolvedLocale: string
  revisionId?: string
  version?: number
  fallbackReason?: string
}

/**
 * Render a generic customer service-request lifecycle outcome.
 *
 * The caller supplies an already-authoritative outcome. Templates can choose
 * wording only; they cannot change service state, matching, or approval truth.
 */
export async function renderServiceRequestCustomerMessage(
  input: ServiceRequestCustomerMessageInput,
): Promise<RenderedServiceRequestCustomerMessage> {
  const eventKey = `service_request.${input.outcome}`
  const context = buildGenericServiceMessageContext({
    entityType: 'service_request',
    entityId: input.entityId,
    reference: input.reference,
    status: input.outcome,
    serviceId: input.serviceId,
    serviceName: input.serviceName,
    summary: input.summary,
    data: {
      ...(input.customerReason ? { customer_reason: input.customerReason } : {}),
    },
  })
  const systemTemplate = findSystemMessageTemplate({
    key: eventKey,
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
  })

  try {
    const resolved = await resolveMessageTemplate({
      accountId: input.accountId,
      eventKey,
      audience: 'customer',
      channel: 'whatsapp',
      locale: input.locale ?? 'ar',
      store: input.store,
    })
    assertSafeServiceRequestTemplate(resolved.template)
    return {
      text: renderMessageTemplate({ template: resolved.template, context }),
      source: resolved.source,
      eventKey: resolved.resolvedEventKey,
      resolvedLocale: resolved.resolvedLocale,
      ...(resolved.revisionId ? { revisionId: resolved.revisionId } : {}),
      ...(resolved.version != null ? { version: resolved.version } : {}),
    }
  } catch (error) {
    if (systemTemplate) {
      try {
        assertSafeServiceRequestTemplate(systemTemplate)
        return {
          text: renderMessageTemplate({ template: systemTemplate, context }),
          source: 'system',
          eventKey,
          resolvedLocale: systemTemplate.locale,
          fallbackReason: safeReason(error),
        }
      } catch {
        // Emergency deterministic copy below.
      }
    }

    return {
      text: emergencyCopy(input.outcome),
      source: 'emergency',
      eventKey,
      resolvedLocale: 'ar',
      fallbackReason: safeReason(error),
    }
  }
}

function assertSafeServiceRequestTemplate(template: MessageTemplateDefinition): void {
  if (template.audience !== 'customer' || template.channel !== 'whatsapp') {
    throw new Error('SERVICE_REQUEST_TEMPLATE_SURFACE_MISMATCH')
  }
  if ((template.secretVariables ?? []).length > 0 || template.body.includes('{{secret.')) {
    throw new Error('SERVICE_REQUEST_TEMPLATE_SECRETS_FORBIDDEN')
  }
}

function emergencyCopy(outcome: ServiceRequestCustomerOutcome): string {
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

function safeReason(error: unknown): string {
  if (!(error instanceof Error)) return 'SERVICE_REQUEST_TEMPLATE_UNAVAILABLE'
  const known = [
    'SERVICE_REQUEST_TEMPLATE_SURFACE_MISMATCH',
    'SERVICE_REQUEST_TEMPLATE_SECRETS_FORBIDDEN',
    'MESSAGE_TEMPLATE_REQUIRED_VARIABLE_MISSING',
    'MESSAGE_TEMPLATE_VARIABLE_MISSING',
    'MESSAGE_TEMPLATE_TOO_LONG',
    'MESSAGE_TEMPLATE_NOT_FOUND',
  ]
  return known.find((code) => error.message.includes(code)) ?? 'SERVICE_REQUEST_TEMPLATE_UNAVAILABLE'
}
