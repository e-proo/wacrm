import { COVERAGE_LEGACY_STRUCTURED_NOTIFICATION_RENDERER } from '@/lib/services/coverage/legacy-notification-adapter'
import { LegacyStructuredNotificationRendererRegistry } from './legacy-structured-notification-renderer-registry'

export const CURRENT_LEGACY_STRUCTURED_NOTIFICATION_RENDERERS =
  new LegacyStructuredNotificationRendererRegistry().register(
    COVERAGE_LEGACY_STRUCTURED_NOTIFICATION_RENDERER,
  )
