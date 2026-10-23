import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import type { MessageTemplate } from '@/types'

export type WhatsAppProvider = 'meta_cloud' | 'openwa'
export type WhatsAppMediaKind = 'image' | 'video' | 'document' | 'audio'

/** Provider-neutral per-send template values. */
export interface WhatsAppTemplateSendParams {
  body?: string[]
  headerText?: string
  headerMediaUrl?: string
  headerMediaId?: string
  buttonParams?: Record<number, string>
}

export type WhatsAppTransportContent =
  | { kind: 'text'; text: string }
  | {
      kind: 'template'
      templateName: string
      language: string
      template?: MessageTemplate
      messageParams?: WhatsAppTemplateSendParams
      params?: string[]
    }
  | {
      kind: 'media'
      mediaKind: WhatsAppMediaKind
      link: string
      caption?: string
      filename?: string
    }
  | { kind: 'interactive'; payload: InteractiveMessagePayload }

export interface WhatsAppTransportSendRequest {
  accountId: string
  connectionId: string
  recipient: string
  content: WhatsAppTransportContent
  replyToProviderMessageId?: string
  idempotencyKey?: string
}

export interface WhatsAppTransportSendResult {
  provider: WhatsAppProvider
  connectionId: string
  providerMessageId: string
  acceptedAt?: string
  providerMetadata?: Record<string, unknown>
}

export type WhatsAppTransportErrorCode =
  | 'unsupported_capability'
  | 'invalid_request'
  | 'authentication_or_configuration'
  | 'recipient_invalid_or_unreachable'
  | 'rate_limited'
  | 'retryable_provider_failure'
  | 'connection_restricted'
  | 'permanent_provider_failure'
  | 'ambiguous_outcome'

export class WhatsAppTransportError extends Error {
  constructor(
    readonly code: WhatsAppTransportErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'WhatsAppTransportError'
  }
}

export interface WhatsAppTransport {
  readonly provider: WhatsAppProvider
  send(request: WhatsAppTransportSendRequest): Promise<WhatsAppTransportSendResult>
}
