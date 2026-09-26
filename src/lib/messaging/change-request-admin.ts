import { buildGenericServiceMessageContext } from './domains'
import { findSystemMessageTemplate } from './current-system-template-registry'
import { renderMessageTemplate } from './renderer'
import { resolveMessageTemplate } from './resolver'
import type {
  MessageTemplateDefinition,
  ResolvedMessageTemplate,
  TemplateOverrideStore,
} from './types'

const EVENT_KEY = 'change_request.pending'
const APPROVAL_SECRET = 'confirmation_code'

export interface PendingChangeRequestAdminMessageInput {
  accountId: string
  changeRequestId: string
  requestCode: number
  confirmationCode: string
  summary?: string | null
  targetType: string
  proposedPayload?: Record<string, unknown> | null
  locale?: string | null
  store?: TemplateOverrideStore | null
}

export interface RenderedPendingChangeRequestAdminMessage {
  text: string
  source: 'account' | 'system'
  resolvedEventKey: string
  resolvedLocale: string
  revisionId?: string
  version?: number
  fallbackReason?: string
}

/**
 * Render the security-sensitive trusted-admin approval message.
 *
 * The confirmation code is supplied only through the transient `secrets` map.
 * It is never copied into MessageContext or template persistence. A malformed
 * account override falls back to the reviewed system template rather than
 * dropping the approval reference/PIN from the notification.
 */
export async function renderPendingChangeRequestAdminMessage(
  input: PendingChangeRequestAdminMessageInput,
): Promise<RenderedPendingChangeRequestAdminMessage> {
  const context = buildPendingContext(input)
  const systemTemplate = requireSystemApprovalTemplate()

  try {
    const resolved = await resolveMessageTemplate({
      accountId: input.accountId,
      eventKey: EVENT_KEY,
      audience: 'admin',
      channel: 'whatsapp',
      locale: input.locale ?? 'ar',
      store: input.store,
    })
    assertSafeApprovalTemplate(resolved.template)
    return toRenderedResult(
      resolved,
      renderMessageTemplate({
        template: resolved.template,
        context,
        secrets: { [APPROVAL_SECRET]: input.confirmationCode },
      }),
    )
  } catch (error) {
    assertSafeApprovalTemplate(systemTemplate)
    return {
      text: renderMessageTemplate({
        template: systemTemplate,
        context,
        secrets: { [APPROVAL_SECRET]: input.confirmationCode },
      }),
      source: 'system',
      resolvedEventKey: EVENT_KEY,
      resolvedLocale: systemTemplate.locale,
      fallbackReason: safeFallbackReason(error),
    }
  }
}

function buildPendingContext(input: PendingChangeRequestAdminMessageInput) {
  const payload = input.proposedPayload ?? {}
  const amount = firstScalar(payload, [
    'total_amount',
    'requested_amount',
    'amount',
    'trade_amount',
  ])
  const currency = firstString(payload, [
    'currency',
    'amount_currency',
    'trade_currency',
  ])
  const serviceId = firstString(payload, ['service_id'])
  const serviceName = firstString(payload, ['service_name'])

  return buildGenericServiceMessageContext({
    entityType: input.targetType,
    entityId: input.changeRequestId,
    reference: `CHG-${input.requestCode}`,
    status: 'pending',
    statusLabel: 'بانتظار الاعتماد',
    serviceId,
    serviceName,
    amount,
    currency,
    summary: input.summary,
    data: {
      type_label: targetTypeLabel(input.targetType),
      target_type: input.targetType,
    },
  })
}

function requireSystemApprovalTemplate(): MessageTemplateDefinition {
  const template = findSystemMessageTemplate({
    key: EVENT_KEY,
    audience: 'admin',
    channel: 'whatsapp',
    locale: 'ar',
  })
  if (!template) throw new Error('SYSTEM_APPROVAL_TEMPLATE_MISSING')
  return template
}

function assertSafeApprovalTemplate(template: MessageTemplateDefinition): void {
  if (template.audience !== 'admin' || template.channel !== 'whatsapp') {
    throw new Error('APPROVAL_TEMPLATE_SURFACE_MISMATCH')
  }
  if (!template.body.includes('{{entity.reference}}')) {
    throw new Error('APPROVAL_TEMPLATE_REFERENCE_REQUIRED')
  }
  if (!(template.secretVariables ?? []).includes(APPROVAL_SECRET)) {
    throw new Error('APPROVAL_TEMPLATE_SECRET_DECLARATION_REQUIRED')
  }
  if (!template.body.includes(`{{secret.${APPROVAL_SECRET}}}`)) {
    throw new Error('APPROVAL_TEMPLATE_SECRET_PLACEHOLDER_REQUIRED')
  }
}

function toRenderedResult(
  resolved: ResolvedMessageTemplate,
  text: string,
): RenderedPendingChangeRequestAdminMessage {
  return {
    text,
    source: resolved.source,
    resolvedEventKey: resolved.resolvedEventKey,
    resolvedLocale: resolved.resolvedLocale,
    ...(resolved.revisionId ? { revisionId: resolved.revisionId } : {}),
    ...(resolved.version != null ? { version: resolved.version } : {}),
  }
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
      'APPROVAL_TEMPLATE_SURFACE_MISMATCH',
      'APPROVAL_TEMPLATE_REFERENCE_REQUIRED',
      'APPROVAL_TEMPLATE_SECRET_DECLARATION_REQUIRED',
      'APPROVAL_TEMPLATE_SECRET_PLACEHOLDER_REQUIRED',
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
