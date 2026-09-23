import { supabaseAdmin } from '@/lib/ai/admin-client'
import { renderCoverageApprovedCustomerMessage } from '@/lib/messaging/coverage-customer'
import { createSupabaseTemplateOverrideStore } from '@/lib/messaging/supabase-store'
import type { CoverageAttributes } from './attributes'
import type { LegacyStructuredNotificationRendererRegistration } from '@/lib/services/platform/legacy-structured-notification-renderer-registry'

interface CoverageNotificationPayload {
  kind: 'offer' | 'request'
  entity_id?: string | null
  reference?: string | null
  service_id?: string | null
  amount: string
  currency: string
  attributes: CoverageAttributes
  commission_amount?: string | null
  commission_currency?: string | null
}

export const COVERAGE_LEGACY_STRUCTURED_NOTIFICATION_RENDERER: LegacyStructuredNotificationRendererRegistration = {
  key: 'coverage.legacy_structured_customer_notification',
  render: async ({ accountId, eventKey, payload: rawPayload }) => {
    if (
      eventKey !== 'coverage.offer.approved' &&
      eventKey !== 'coverage.request.approved'
    ) {
      return null
    }

    const payload = rawPayload as unknown as CoverageNotificationPayload
    const db = supabaseAdmin()
    const regionIds = [
      payload.attributes?.pay_region_id,
      payload.attributes?.receive_region_id,
    ].filter((id): id is string => Boolean(id))
    const regionNames = new Map<string, string>()

    if (regionIds.length > 0) {
      const { data: regions, error } = await db
        .from('coverage_regions')
        .select('id, name, code')
        .eq('account_id', accountId)
        .in('id', [...new Set(regionIds)])
      if (error) throw error
      for (const region of regions ?? []) {
        regionNames.set(region.id, region.name || region.code || region.id)
      }
    }

    const payRegion =
      (payload.attributes?.pay_region_id &&
        regionNames.get(payload.attributes.pay_region_id)) ||
      payload.attributes?.coverage_country ||
      'غير محدد'
    const receiveRegion =
      (payload.attributes?.receive_region_id &&
        regionNames.get(payload.attributes.receive_region_id)) ||
      payload.attributes?.coverage_country ||
      'غير محدد'

    const rendered = await renderCoverageApprovedCustomerMessage({
      accountId,
      kind: payload.kind,
      entityId: payload.entity_id,
      reference: payload.reference,
      serviceId: payload.service_id,
      amount: payload.amount,
      currency: payload.currency,
      payRegion,
      payMethod: payload.attributes?.pay_method ?? 'any',
      receiveRegion,
      receiveMethod: payload.attributes?.receive_method ?? 'any',
      commissionAmount: payload.commission_amount,
      commissionCurrency: payload.commission_currency,
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
