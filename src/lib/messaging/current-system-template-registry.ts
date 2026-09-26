import { GENERAL_SYSTEM_MESSAGE_TEMPLATES } from './defaults'
import { SystemTemplateRegistry } from './system-template-registry'
import { CURRENT_BUSINESS_DOMAIN_MODULES } from '@/lib/services/platform/domain-catalog'
import type {
  MessageAudience,
  MessageChannel,
  MessageTemplateDefinition,
} from './types'

export const CURRENT_SYSTEM_TEMPLATE_REGISTRY = new SystemTemplateRegistry()
  .register('messaging', GENERAL_SYSTEM_MESSAGE_TEMPLATES)

for (const domain of CURRENT_BUSINESS_DOMAIN_MODULES) {
  CURRENT_SYSTEM_TEMPLATE_REGISTRY.register(domain.key, domain.messageTemplates)
}

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
