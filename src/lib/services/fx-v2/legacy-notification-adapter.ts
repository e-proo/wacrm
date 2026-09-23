import { renderFxTradeBusinessEventText } from '@/lib/messaging/fx-v2-outbox'
import type { LegacyCustomerNotificationRendererRegistration } from '@/lib/services/platform/legacy-notification-renderer-registry'

export const FX_V2_LEGACY_NOTIFICATION_RENDERER: LegacyCustomerNotificationRendererRegistration = {
  key: 'exchange_rates.legacy_customer_notification',
  matches: (notification) => Boolean(notification.fxTradeRequestId),
  render: async ({ accountId, notification }) => {
    if (!notification.fxTradeRequestId) {
      throw new Error('FX_LEGACY_NOTIFICATION_TRADE_MISSING')
    }
    return renderFxTradeBusinessEventText({
      accountId,
      tradeRequestId: notification.fxTradeRequestId,
      eventType: notification.eventType,
    })
  },
}
