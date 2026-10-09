export type MessageAudience = 'customer' | 'admin' | 'internal'
export type MessageChannel = 'whatsapp' | 'in_app' | 'email' | 'sms'

export type MessageScalar = string | number | boolean | null
export type MessageValue = MessageScalar | MessageValue[] | { [key: string]: MessageValue }

export interface MessageContext {
  account?: {
    id?: string
    name?: string
  }
  customer?: {
    id?: string
    name?: string
    phone?: string
  }
  actor?: {
    id?: string
    name?: string
    type?: 'customer' | 'admin' | 'system' | 'agent'
  }
  entity: {
    id?: string
    type: string
    reference?: string
    status?: string
    status_label?: string
  }
  service?: {
    id?: string
    code?: string
    name?: string
  }
  money?: {
    amount?: string
    currency?: string
    fee?: string
    commission?: string
    commission_currency?: string
  }
  data: Record<string, MessageValue>
}

export interface MessageTemplateDefinition {
  key: string
  audience: MessageAudience
  channel: MessageChannel
  locale: string
  body: string
  requiredVariables?: readonly string[]
  optionalVariables?: readonly string[]
  secretVariables?: readonly string[]
  maxLength?: number
}

export interface PublishedTemplateOverride extends MessageTemplateDefinition {
  revisionId: string
  version: number
}

export interface TemplateOverrideStore {
  getPublishedTemplate(input: {
    accountId: string
    key: string
    audience: MessageAudience
    channel: MessageChannel
    locale: string
  }): Promise<PublishedTemplateOverride | null>
}

export interface ResolvedMessageTemplate {
  template: MessageTemplateDefinition
  source: 'account' | 'system'
  requestedEventKey: string
  resolvedEventKey: string
  resolvedLocale: string
  revisionId?: string
  version?: number
}

export interface RenderMessageInput {
  template: MessageTemplateDefinition
  context: MessageContext
  secrets?: Record<string, string>
}
