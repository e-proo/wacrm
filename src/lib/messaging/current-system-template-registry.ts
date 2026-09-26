import { GENERAL_SYSTEM_MESSAGE_TEMPLATES } from './defaults'
import { LEGACY_SYSTEM_MESSAGE_TEMPLATES } from './legacy-system-templates'
import { SystemTemplateRegistry } from './system-template-registry'
import { COVERAGE_MESSAGE_TEMPLATES } from '@/lib/services/coverage/messages/templates'
import { FX_V2_MESSAGE_TEMPLATES } from '@/lib/services/fx-v2/messages/templates'
import type {
  MessageAudience,
  MessageChannel,
  MessageTemplateDefinition,
} from './types'

export const CURRENT_SYSTEM_TEMPLATE_REGISTRY = new SystemTemplateRegistry()
  .register('messaging', GENERAL_SYSTEM_MESSAGE_TEMPLATES)
  .register('legacy-remittance', LEGACY_SYSTEM_MESSAGE_TEMPLATES)

CURRENT_SYSTEM_TEMPLATE_REGISTRY
  .register('coverage', COVERAGE_MESSAGE_TEMPLATES)
  .register('exchange_rates', FX_V2_MESSAGE_TEMPLATES)

export function findSystemMessageTemplate(input: {
  key: string
  audience: MessageAudience
  channel: MessageChannel
  locale: string
}): MessageTemplateDefinition | null {
  return CURRENT_SYSTEM_TEMPLATE_REGISTRY.find(input)
}

export function listCurrentSystemMessageTemplates(): readonly MessageTemplateDefinition[] {
  return CURRENT_SYSTEM_TEMPLATE_REGISTRY.list()
}
