import { assertMessageEventKey } from './catalog'
import type {
  MessageAudience,
  MessageChannel,
  MessageTemplateDefinition,
} from './types'

const AUDIENCES = new Set<MessageAudience>(['customer', 'admin', 'internal'])
const CHANNELS = new Set<MessageChannel>(['whatsapp', 'in_app', 'email', 'sms'])

function idOf(template: Pick<MessageTemplateDefinition, 'key' | 'audience' | 'channel' | 'locale'>): string {
  return [
    template.key,
    template.audience,
    template.channel,
    template.locale.trim().toLowerCase(),
  ].join('|')
}

export function validateSystemTemplateDefinition(
  template: MessageTemplateDefinition,
): void {
  assertMessageEventKey(template.key)
  if (!AUDIENCES.has(template.audience)) {
    throw new Error('SYSTEM_TEMPLATE_AUDIENCE_INVALID:' + template.key)
  }
  if (!CHANNELS.has(template.channel)) {
    throw new Error('SYSTEM_TEMPLATE_CHANNEL_INVALID:' + template.key)
  }
  if (!template.locale.trim() || !template.body.trim()) {
    throw new Error('SYSTEM_TEMPLATE_CONTENT_INVALID:' + template.key)
  }
  if (
    template.maxLength !== undefined &&
    (!Number.isSafeInteger(template.maxLength) || template.maxLength < 1)
  ) {
    throw new Error('SYSTEM_TEMPLATE_MAX_LENGTH_INVALID:' + template.key)
  }

  const declaredSecrets = new Set(template.secretVariables ?? [])
  const directSecrets = [
    ...template.body.matchAll(/{{\s*secret\.([a-zA-Z0-9_.]+)\s*}}/g),
  ]
  const conditionalSecrets = [
    ...template.body.matchAll(/{{#if\s+secret\.([a-zA-Z0-9_.]+)}}/g),
  ]
  for (const match of [...directSecrets, ...conditionalSecrets]) {
    if (!declaredSecrets.has(match[1])) {
      throw new Error(
        'SYSTEM_TEMPLATE_SECRET_NOT_DECLARED:' + template.key + ':' + match[1],
      )
    }
  }
}

export class SystemTemplateRegistry {
  private readonly templates = new Map<
    string,
    { owner: string; template: MessageTemplateDefinition }
  >()

  register(
    owner: string,
    templates: readonly MessageTemplateDefinition[],
  ): this {
    if (!owner.trim()) throw new Error('SYSTEM_TEMPLATE_OWNER_REQUIRED')

    for (const template of templates) {
      validateSystemTemplateDefinition(template)
      const id = idOf(template)
      const existing = this.templates.get(id)
      if (existing) {
        throw new Error(
          'SYSTEM_TEMPLATE_DUPLICATE:' +
            id +
            ':owners=' +
            existing.owner +
            ',' +
            owner,
        )
      }
      this.templates.set(id, { owner, template })
    }
    return this
  }

  find(input: {
    key: string
    audience: MessageAudience
    channel: MessageChannel
    locale: string
  }): MessageTemplateDefinition | null {
    return (
      this.templates.get(
        [
          input.key,
          input.audience,
          input.channel,
          input.locale.trim().toLowerCase(),
        ].join('|'),
      )?.template ?? null
    )
  }

  ownerOf(input: {
    key: string
    audience: MessageAudience
    channel: MessageChannel
    locale: string
  }): string | null {
    return (
      this.templates.get(
        [
          input.key,
          input.audience,
          input.channel,
          input.locale.trim().toLowerCase(),
        ].join('|'),
      )?.owner ?? null
    )
  }

  list(): readonly MessageTemplateDefinition[] {
    return [...this.templates.values()].map((entry) => entry.template)
  }
}
