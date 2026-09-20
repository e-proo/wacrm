import { findSystemMessageTemplate } from '@/lib/messaging/defaults'
import { renderMessageTemplate } from '@/lib/messaging/renderer'
import { resolveMessageTemplate } from '@/lib/messaging/resolver'
import type {
  MessageTemplateDefinition,
  TemplateOverrideStore,
} from '@/lib/messaging/types'
import type { BusinessEventMessageProjection } from './event-projector-registry'

export interface RenderedBusinessEventMessage {
  text: string
  source: 'account' | 'system' | 'emergency'
  eventKey: string
  resolvedLocale: string
  revisionId?: string
  version?: number
  fallbackReason?: string
}

export async function renderBusinessEventProjection(input: {
  accountId: string
  projection: BusinessEventMessageProjection
  store?: TemplateOverrideStore | null
}): Promise<RenderedBusinessEventMessage> {
  const { projection } = input
  const systemTemplate = findSystemMessageTemplate({
    key: projection.eventKey,
    audience: projection.audience,
    channel: projection.channel,
    locale: projection.locale,
  })

  try {
    const resolved = await resolveMessageTemplate({
      accountId: input.accountId,
      eventKey: projection.eventKey,
      audience: projection.audience,
      channel: projection.channel,
      locale: projection.locale,
      store: input.store,
    })
    assertProjectionTemplate(resolved.template, projection)
    return {
      text: renderMessageTemplate({
        template: resolved.template,
        context: projection.context,
      }),
      source: resolved.source,
      eventKey: resolved.resolvedEventKey,
      resolvedLocale: resolved.resolvedLocale,
      ...(resolved.revisionId ? { revisionId: resolved.revisionId } : {}),
      ...(resolved.version != null ? { version: resolved.version } : {}),
    }
  } catch (error) {
    if (systemTemplate) {
      try {
        assertProjectionTemplate(systemTemplate, projection)
        return {
          text: renderMessageTemplate({
            template: systemTemplate,
            context: projection.context,
          }),
          source: 'system',
          eventKey: projection.eventKey,
          resolvedLocale: systemTemplate.locale,
          fallbackReason: safeProjectionReason(error),
        }
      } catch {
        // The domain-owned emergency text below is still built from the same
        // authoritative event projection; no AI prose or current business
        // recalculation is introduced here.
      }
    }

    if (projection.emergencyText) {
      return {
        text: projection.emergencyText,
        source: 'emergency',
        eventKey: projection.eventKey,
        resolvedLocale: projection.locale,
        fallbackReason: safeProjectionReason(error),
      }
    }

    throw error
  }
}

function assertProjectionTemplate(
  template: MessageTemplateDefinition,
  projection: BusinessEventMessageProjection,
): void {
  if (
    template.audience !== projection.audience ||
    template.channel !== projection.channel
  ) {
    throw new Error('BUSINESS_EVENT_TEMPLATE_SURFACE_MISMATCH')
  }

  if (projection.templatePolicy?.forbidSecrets) {
    if (
      (template.secretVariables ?? []).length > 0 ||
      template.body.includes('{{secret.')
    ) {
      throw new Error('BUSINESS_EVENT_TEMPLATE_SECRETS_FORBIDDEN')
    }
  }

  for (const placeholder of projection.templatePolicy?.requiredBodyPlaceholders ?? []) {
    if (!template.body.includes(placeholder)) {
      throw new Error(
        'BUSINESS_EVENT_TEMPLATE_FACT_REQUIRED:' + placeholder,
      )
    }
  }
}

function safeProjectionReason(error: unknown): string {
  if (!(error instanceof Error)) return 'BUSINESS_EVENT_TEMPLATE_UNAVAILABLE'
  const message = error.message || 'BUSINESS_EVENT_TEMPLATE_UNAVAILABLE'
  return message.split(':', 1)[0] || 'BUSINESS_EVENT_TEMPLATE_UNAVAILABLE'
}
