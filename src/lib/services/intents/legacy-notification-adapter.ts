import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  renderServiceRequestCustomerMessage,
  type ServiceRequestCustomerOutcome,
} from '@/lib/messaging/service-request-customer'
import { createSupabaseTemplateOverrideStore } from '@/lib/messaging/supabase-store'
import type { LegacyCustomerNotificationRendererRegistration } from '@/lib/services/platform/legacy-notification-renderer-registry'

export const INTENTS_LEGACY_NOTIFICATION_RENDERER: LegacyCustomerNotificationRendererRegistration = {
  key: 'intents.legacy_customer_notification',
  render: async ({ accountId, notification }) => {
    if (!notification.intentId || !notification.changeRequestId) return null

    const db = supabaseAdmin()
    const { data: change, error } = await db
      .from('change_requests')
      .select('target_type, target_id, proposed_payload, execution_result')
      .eq('account_id', accountId)
      .eq('id', notification.changeRequestId)
      .maybeSingle()
    if (error) throw error
    if (!change || change.target_type !== 'service_intent') return null

    const proposed = asRecord(change.proposed_payload)
    const execution = asRecord(change.execution_result)
    const decision =
      stringValue(execution?.decision) ?? stringValue(proposed?.decision)
    const outcome = serviceRequestOutcome(decision)
    if (!outcome) return null

    const serviceId =
      outcome === 'matched' ? stringValue(proposed?.matched_service_id) : null
    const serviceName = serviceId
      ? await loadServiceName(accountId, serviceId)
      : null
    const customerReason = stringValue(proposed?.customer_reason)

    const rendered = await renderServiceRequestCustomerMessage({
      accountId,
      outcome,
      entityId: change.target_id ?? notification.intentId,
      serviceId,
      serviceName,
      customerReason,
      store: createSupabaseTemplateOverrideStore(db),
    })

    console.info(
      [
        `[messaging] event=${rendered.eventKey}`,
        `source=${rendered.source}`,
        `template=${rendered.eventKey}`,
        `locale=${rendered.resolvedLocale}`,
        'channel=whatsapp',
        rendered.revisionId ? `revision=${rendered.revisionId}` : null,
        rendered.version != null ? `version=${rendered.version}` : null,
        rendered.fallbackReason
          ? `fallback=${rendered.fallbackReason}`
          : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' '),
    )

    return rendered.text
  },
}

function serviceRequestOutcome(
  decision: string | null,
): ServiceRequestCustomerOutcome | null {
  switch (decision) {
    case 'fulfilled':
      return 'approved'
    case 'rejected':
      return 'rejected'
    case 'matched':
      return 'matched'
    case 'clarifying':
      return 'needs_clarification'
    default:
      return null
  }
}

async function loadServiceName(
  accountId: string,
  serviceId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('services')
    .select('name')
    .eq('account_id', accountId)
    .eq('id', serviceId)
    .maybeSingle()
  if (error) throw error
  return typeof data?.name === 'string' && data.name.trim()
    ? data.name.trim()
    : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
