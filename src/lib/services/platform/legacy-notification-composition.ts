import { FX_V2_LEGACY_NOTIFICATION_RENDERER } from '@/lib/services/fx-v2/legacy-notification-adapter'
import { LegacyCustomerNotificationRendererRegistry } from './legacy-notification-renderer-registry'

export const CURRENT_LEGACY_NOTIFICATION_RENDERERS =
  new LegacyCustomerNotificationRendererRegistry().register(
    FX_V2_LEGACY_NOTIFICATION_RENDERER,
  )
