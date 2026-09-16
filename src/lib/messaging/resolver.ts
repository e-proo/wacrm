import { buildLocaleFallbackChain, buildMessageEventFallbackChain } from './catalog'
import { findSystemMessageTemplate } from './defaults'
import type {
  MessageAudience,
  MessageChannel,
  ResolvedMessageTemplate,
  TemplateOverrideStore,
} from './types'

export async function resolveMessageTemplate(input: {
  accountId: string
  eventKey: string
  audience: MessageAudience
  channel: MessageChannel
  locale?: string | null
  store?: TemplateOverrideStore | null
}): Promise<ResolvedMessageTemplate> {
  const eventChain = buildMessageEventFallbackChain(input.eventKey)
  const localeChain = buildLocaleFallbackChain(input.locale ?? 'ar')

  if (input.store) {
    for (const eventKey of eventChain) {
      for (const locale of localeChain) {
        const override = await input.store.getPublishedTemplate({
          accountId: input.accountId,
          key: eventKey,
          audience: input.audience,
          channel: input.channel,
          locale,
        })
        if (override) {
          return {
            template: override,
            source: 'account',
            requestedEventKey: input.eventKey,
            resolvedEventKey: eventKey,
            resolvedLocale: locale,
            revisionId: override.revisionId,
            version: override.version,
          }
        }
      }
    }
  }

  for (const eventKey of eventChain) {
    for (const locale of localeChain) {
      const system = findSystemMessageTemplate({
        key: eventKey,
        audience: input.audience,
        channel: input.channel,
        locale,
      })
      if (system) {
        return {
          template: system,
          source: 'system',
          requestedEventKey: input.eventKey,
          resolvedEventKey: eventKey,
          resolvedLocale: locale,
        }
      }
    }
  }

  throw new Error(
    `MESSAGE_TEMPLATE_NOT_FOUND:${input.eventKey}:${input.audience}:${input.channel}:${input.locale ?? 'ar'}`,
  )
}
