import { buildCoverageMessageContext, formatMessageNumber } from './domains'
import { findSystemMessageTemplate } from './defaults'
import { renderMessageTemplate } from './renderer'
import { resolveMessageTemplate } from './resolver'
import type { MessageTemplateDefinition, TemplateOverrideStore } from './types'

export type CoverageCustomerOutcomeKind = 'offer' | 'request'

export interface CoverageApprovedCustomerMessageInput {
  accountId: string
  kind: CoverageCustomerOutcomeKind
  entityId?: string | null
  reference?: string | null
  serviceId?: string | null
  serviceName?: string | null
  amount: string | number
  currency: string
  payRegion: string
  payMethod: string
  receiveRegion: string
  receiveMethod: string
  commissionPerThousand?: string | number | null
  commissionCurrency?: string | null
  locale?: string | null
  store?: TemplateOverrideStore | null
}

export interface RenderedCoverageCustomerMessage {
  text: string
  source: 'account' | 'system' | 'emergency'
  eventKey: string
  resolvedLocale: string
  revisionId?: string
  version?: number
  fallbackReason?: string
}

/**
 * Render the customer-facing coverage approval outcome.
 *
 * Business direction/effect is not inferred from prose. The deterministic
 * executor has already classified the target as offer or request; this renderer
 * only presents that authoritative result. Account overrides cannot change the
 * numerical inputs supplied here.
 */
export async function renderCoverageApprovedCustomerMessage(
  input: CoverageApprovedCustomerMessageInput,
): Promise<RenderedCoverageCustomerMessage> {
  const eventKey = input.kind === 'offer' ? 'coverage.offer.approved' : 'coverage.request.approved'
  const commissionAmount = calculateCommission(input.amount, input.commissionPerThousand)
  const commissionEffect = input.kind === 'offer' ? 'customer_receives' : 'customer_pays'
  const context = buildCoverageMessageContext({
    entityType: input.kind === 'offer' ? 'coverage_offer' : 'coverage_request',
    entityId: input.entityId,
    reference: input.reference,
    serviceId: input.serviceId,
    serviceName: input.serviceName,
    amount: input.amount,
    currency: input.currency,
    payRegion: input.payRegion,
    payMethod: coverageMethodLabel(input.payMethod),
    receiveRegion: input.receiveRegion,
    receiveMethod: coverageMethodLabel(input.receiveMethod),
    commissionAmount,
    commissionCurrency: input.commissionCurrency ?? input.currency,
    commissionEffect,
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
    assertCoverageCustomerTemplate(resolved.template)
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
        assertCoverageCustomerTemplate(systemTemplate)
        return {
          text: renderMessageTemplate({ template: systemTemplate, context }),
          source: 'system',
          eventKey,
          resolvedLocale: systemTemplate.locale,
          fallbackReason: safeReason(error),
        }
      } catch {
        // Emergency copy below intentionally uses the same authoritative data.
      }
    }

    const reference = input.reference
      ? `\n${input.kind === 'offer' ? 'رقم العرض' : 'رقم الطلب'}: ${input.reference}`
      : ''
    const commission =
      commissionAmount != null
        ? `\n${input.kind === 'offer' ? 'الراجع لك' : 'العمولة عليك'}: ${formatMessageNumber(commissionAmount)} ${input.commissionCurrency ?? input.currency}`
        : ''
    return {
      text:
        `${input.kind === 'offer' ? '✅ تم اعتماد عرض التغطية الخاص بك.' : '✅ تم اعتماد طلب التغطية الخاص بك.'}` +
        reference +
        `\nالمبلغ: ${formatMessageNumber(input.amount)} ${input.currency}` +
        commission,
      source: 'emergency',
      eventKey,
      resolvedLocale: 'ar',
      fallbackReason: safeReason(error),
    }
  }
}

function assertCoverageCustomerTemplate(template: MessageTemplateDefinition): void {
  if (template.audience !== 'customer' || template.channel !== 'whatsapp') {
    throw new Error('COVERAGE_TEMPLATE_SURFACE_MISMATCH')
  }
  if ((template.secretVariables ?? []).length > 0 || template.body.includes('{{secret.')) {
    throw new Error('COVERAGE_TEMPLATE_SECRETS_FORBIDDEN')
  }
  for (const required of ['{{money.amount}}', '{{money.currency}}']) {
    if (!template.body.includes(required)) throw new Error('COVERAGE_TEMPLATE_AMOUNT_REQUIRED')
  }
}

function calculateCommission(
  amount: string | number,
  perThousand: string | number | null | undefined,
): number | null {
  if (perThousand == null || perThousand === '') return null
  const numericAmount = Number(amount)
  const numericRate = Number(perThousand)
  if (!Number.isFinite(numericAmount) || !Number.isFinite(numericRate)) return null
  return (numericAmount * numericRate) / 1000
}

function coverageMethodLabel(method: string): string {
  const labels: Record<string, string> = {
    cash: 'نقدًا',
    networks: 'شبكات',
    remittance: 'حوالة',
    bank_deposit: 'إيداع بنكي',
    any: 'أي طريقة متاحة',
  }
  return labels[method] ?? method
}

function safeReason(error: unknown): string {
  if (!(error instanceof Error)) return 'COVERAGE_TEMPLATE_UNAVAILABLE'
  const known = [
    'COVERAGE_TEMPLATE_SURFACE_MISMATCH',
    'COVERAGE_TEMPLATE_SECRETS_FORBIDDEN',
    'COVERAGE_TEMPLATE_AMOUNT_REQUIRED',
    'MESSAGE_TEMPLATE_REQUIRED_VARIABLE_MISSING',
    'MESSAGE_TEMPLATE_VARIABLE_MISSING',
    'MESSAGE_TEMPLATE_TOO_LONG',
    'MESSAGE_TEMPLATE_NOT_FOUND',
  ]
  return known.find((code) => error.message.includes(code)) ?? 'COVERAGE_TEMPLATE_UNAVAILABLE'
}
