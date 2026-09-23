import { supabaseAdmin } from '@/lib/ai/admin-client'
import { renderFxTradeBusinessEventText } from '@/lib/messaging/fx-v2-outbox'
import type { LegacyCustomerNotificationRendererRegistration } from '@/lib/services/platform/legacy-notification-renderer-registry'

export const FX_V2_LEGACY_NOTIFICATION_RENDERER: LegacyCustomerNotificationRendererRegistration = {
  key: 'exchange_rates.legacy_customer_notification',
  render: async ({ accountId, notification }) => {
    const { data, error } = await supabaseAdmin()
      .from('customer_intent_notifications')
      .select('fx_trade_request_id, event_type')
      .eq('account_id', accountId)
      .eq('id', notification.id)
      .maybeSingle()
    if (error) throw error
    if (!data?.fx_trade_request_id) return null

    return renderFxTradeBusinessEventText({
      accountId,
      tradeRequestId: data.fx_trade_request_id,
      eventType: data.event_type ?? notification.eventType,
    })
  },
}
