import { buildGenericServiceMessageContext } from './domains'
import { findSystemMessageTemplate } from './defaults'
import { renderMessageTemplate } from './renderer'
import { resolveMessageTemplate } from './resolver'
import type {
  MessageTemplateDefinition,
  ResolvedMessageTemplate,
  TemplateOverrideStore,
} from './types'

export type AdminChangeOutcome = 'approved' | 'rejected'

export interface ChangeRequestAdminOutcomeMessageInput {
  accountId: string
  changeRequestId: string
  requestCode: number
  outcome: AdminChangeOutcome
  targetType: string
  proposedPayload?: Record<string, unknown> | null
  summary?: string | null
  reason?: string | null
  customerDeliveryLabel?: string | null
  locale?: string | null
  store?: TemplateOverrideStore | null
}

export interface RenderedChangeRequestAdminOutcomeMessage {
  text: string
  source: 'account' | 'system' | 'emergency'
  resolvedEventKey: string
  resolvedLocale: string
  revisionId?: string
  version?: number
  fallbackReason?: string
}

/**
 * Render an admin-facing outcome only after deterministic business state has
 * already been decided. Template failure must never turn a successful approval
 * or rejection into a misleading operational failure response.
 */
export async function renderChangeRequestAdminOutcomeMessage(
  input: ChangeRequestAdminOutcomeMessageInput,
): Promise<RenderedChangeRequestAdminOutcomeMessage> {
  const eventKey = `change_request.${input.outcome}`
  const context = buildOutcomeContext(input)
  const systemTemplate = findSystemMessageTemplate({
    key: eventKey,
    audience: 'admin',
    channel: 'whatsapp',
    locale: 'ar',
  })

  try {
    const resolved = await resolveMessageTemplate({
      accountId: input.accountId,
      eventKey,
      audience: 'admin',
      channel: 'whatsapp',
      locale: input.locale ?? 'ar',
      store: input.store,
    })
    assertSafeOutcomeTemplate(resolved.template)
    return toRenderedResult(
      resolved,
      renderMessageTemplate({ template: resolved.template, context }),
    )
  } catch (error) {
    const fallbackReason = safeFallbackReason(error)
    if (systemTemplate) {
      try {
        assertSafeOutcomeTemplate(systemTemplate)
        return {
          text: renderMessageTemplate({ template: systemTemplate, context }),
          source: 'system',
          resolvedEventKey: eventKey,
          resolvedLocale: systemTemplate.locale,
          fallbackReason,
        }
      } catch (systemError) {
        return {
          text: emergencyOutcomeText(input),
          source: 'emergency',
          resolvedEventKey: eventKey,
          resolvedLocale: 'ar',
          fallbackReason: `SYSTEM_TEMPLATE_FAILED:${safeFallbackReason(systemError)}`,
        }
      }
    }

    return {
      text: emergencyOutcomeText(input),
      source: 'emergency',
      resolvedEventKey: eventKey,
      resolvedLocale: 'ar',
      fallbackReason: `SYSTEM_TEMPLATE_MISSING:${fallbackReason}`,
    }
  }
}

function buildOutcomeContext(input: ChangeRequestAdminOutcomeMessageInput) {
  const payload = input.proposedPayload ?? {}
  const amount = firstScalar(payload, ['total_amount', 'requested_amount', 'amount', 'trade_amount'])
  const currency = firstString(payload, ['currency', 'amount_currency', 'trade_currency'])
  const serviceId = firstString(payload, ['service_id'])
  const serviceName = firstString(payload, ['service_name'])

  return buildGenericServiceMessageContext({
    entityType: input.targetType,
    entityId: input.changeRequestId,
    reference: `CHG-${input.requestCode}`,
    status: input.outcome === 'approved' ? 'executed' : 'rejected',
    statusLabel: input.outcome === 'approved' ? 'تم التنفيذ' : 'مرفوض',
    serviceId,
    serviceName,
    amount,
    currency,
    summary: input.summary,
    data: {
      type_label: targetTypeLabel(input.targetType),
      target_type: input.targetType,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.customerDeliveryLabel
        ? { customer_delivery_label: input.customerDeliveryLabel }
        : {}),
    },
  })
}

function assertSafeOutcomeTemplate(template: MessageTemplateDefinition): void {
  if (template.audience !== 'admin' || template.channel !== 'whatsapp') {
    throw new Error('ADMIN_OUTCOME_TEMPLATE_SURFACE_MISMATCH')
  }
  if (!template.body.includes('{{entity.reference}}')) {
    throw new Error('ADMIN_OUTCOME_TEMPLATE_REFERENCE_REQUIRED')
  }
  if ((template.secretVariables ?? []).length > 0 || template.body.includes('{{secret.')) {
    throw new Error('ADMIN_OUTCOME_TEMPLATE_SECRETS_FORBIDDEN')
  }
}

function toRenderedResult(
  resolved: ResolvedMessageTemplate,
  text: string,
): RenderedChangeRequestAdminOutcomeMessage {
  return {
    text,
    source: resolved.source,
    resolvedEventKey: resolved.resolvedEventKey,
    resolvedLocale: resolved.resolvedLocale,
    ...(resolved.revisionId ? { revisionId: resolved.revisionId } : {}),
    ...(resolved.version != null ? { version: resolved.version } : {}),
  }
}

function emergencyOutcomeText(input: ChangeRequestAdminOutcomeMessageInput): string {
  if (input.outcome === 'approved') {
    const delivery = input.customerDeliveryLabel ? `\nالعميل: ${input.customerDeliveryLabel}` : ''
    return `✅ تم اعتماد وتنفيذ CHG-${input.requestCode} بنجاح.${delivery}`
  }
  const reason = input.reason ? `\nالسبب: ${input.reason}` : ''
  const delivery = input.customerDeliveryLabel ? `\nالعميل: ${input.customerDeliveryLabel}` : ''
  return `⛔ تم رفض CHG-${input.requestCode}.${reason}${delivery}`
}

function firstString(payload: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function firstScalar(
  payload: Record<string, unknown>,
  keys: readonly string[],
): string | number | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function targetTypeLabel(targetType: string): string {
  const labels: Record<string, string> = {
    coverage_offer: 'عرض تغطية',
    coverage_request: 'طلب تغطية',
    fx_rate_pair: 'تحديث زوج أسعار صرف',
    fx_trade_request: 'قرار طلب صرف عملة',
    exchange_rate_trade: 'طلب صرف عملة',
    service_intent: 'طلب خدمة',
    service: 'خدمة',
    pricing_rule: 'قاعدة تسعير',
    remittance: 'حوالة',
  }
  return labels[targetType] ?? targetType
}

function safeFallbackReason(error: unknown): string {
  if (error instanceof Error) {
    const known = [
      'ADMIN_OUTCOME_TEMPLATE_SURFACE_MISMATCH',
      'ADMIN_OUTCOME_TEMPLATE_REFERENCE_REQUIRED',
      'ADMIN_OUTCOME_TEMPLATE_SECRETS_FORBIDDEN',
      'MESSAGE_TEMPLATE_REQUIRED_VARIABLE_MISSING',
      'MESSAGE_TEMPLATE_VARIABLE_MISSING',
      'MESSAGE_TEMPLATE_SECRET_NOT_ALLOWED',
      'MESSAGE_TEMPLATE_TOO_LONG',
      'MESSAGE_TEMPLATE_NOT_FOUND',
    ]
    return known.find((code) => error.message.includes(code)) ?? 'MESSAGE_TEMPLATE_OVERRIDE_UNAVAILABLE'
  }
  return 'MESSAGE_TEMPLATE_OVERRIDE_UNAVAILABLE'
}
