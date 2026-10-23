import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import {
  isRecipientNotAllowedError,
  phoneVariants,
} from '@/lib/whatsapp/phone-utils'
import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTemplateMessage,
  sendTextMessage,
} from '@/lib/whatsapp/meta-api'
import {
  WhatsAppTransportError,
  type WhatsAppTransport,
  type WhatsAppTransportSendRequest,
  type WhatsAppTransportSendResult,
} from '@/lib/whatsapp/transport/types'

interface MetaConfigRow {
  id: string
  account_id: string
  phone_number_id: string
  access_token: string
}

interface MetaConnectionRow {
  id: string
  account_id: string
  provider: 'meta_cloud'
  provider_external_id: string | null
}

export interface ResolvedMetaTransport {
  connectionId: string
  transport: WhatsAppTransport
}

class MetaWhatsAppTransport implements WhatsAppTransport {
  readonly provider = 'meta_cloud' as const

  constructor(
    private readonly accountId: string,
    private readonly connectionId: string,
    private readonly phoneNumberId: string,
    private readonly accessToken: string,
  ) {}

  async send(request: WhatsAppTransportSendRequest): Promise<WhatsAppTransportSendResult> {
    if (request.accountId !== this.accountId || request.connectionId !== this.connectionId) {
      throw new WhatsAppTransportError(
        'invalid_request',
        'WhatsApp transport request does not match the resolved account connection',
      )
    }

    const attempt = async (recipient: string): Promise<string> => {
      const contextMessageId = request.replyToProviderMessageId
      const content = request.content
      if (content.kind === 'template') {
        return (
          await sendTemplateMessage({
            phoneNumberId: this.phoneNumberId,
            accessToken: this.accessToken,
            to: recipient,
            templateName: content.templateName,
            language: content.language,
            template: content.template,
            messageParams: content.messageParams,
            params: content.params ?? [],
            contextMessageId,
          })
        ).messageId
      }
      if (content.kind === 'media') {
        return (
          await sendMediaMessage({
            phoneNumberId: this.phoneNumberId,
            accessToken: this.accessToken,
            to: recipient,
            kind: content.mediaKind,
            link: content.link,
            caption: content.caption,
            filename: content.filename,
            contextMessageId,
          })
        ).messageId
      }
      if (content.kind === 'interactive') {
        const payload = content.payload
        if (payload.kind === 'buttons') {
          return (
            await sendInteractiveButtons({
              phoneNumberId: this.phoneNumberId,
              accessToken: this.accessToken,
              to: recipient,
              bodyText: payload.body,
              headerText: payload.header || undefined,
              footerText: payload.footer || undefined,
              buttons: payload.buttons,
              contextMessageId,
            })
          ).messageId
        }
        return (
          await sendInteractiveList({
            phoneNumberId: this.phoneNumberId,
            accessToken: this.accessToken,
            to: recipient,
            bodyText: payload.body,
            buttonLabel: payload.button_label,
            headerText: payload.header || undefined,
            footerText: payload.footer || undefined,
            sections: payload.sections,
            contextMessageId,
          })
        ).messageId
      }
      return (
        await sendTextMessage({
          phoneNumberId: this.phoneNumberId,
          accessToken: this.accessToken,
          to: recipient,
          text: content.text,
          contextMessageId,
        })
      ).messageId
    }

    let providerMessageId = ''
    let workingRecipient = request.recipient
    let lastError: unknown = null
    for (const variant of phoneVariants(request.recipient)) {
      try {
        providerMessageId = await attempt(variant)
        workingRecipient = variant
        lastError = null
        break
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!isRecipientNotAllowedError(message)) throw error
        lastError = error
      }
    }
    if (lastError) throw lastError

    return {
      provider: 'meta_cloud',
      connectionId: this.connectionId,
      providerMessageId,
      providerMetadata:
        workingRecipient === request.recipient ? undefined : { workingRecipient },
    }
  }
}

/** Resolve Meta credentials only after proving account + connection ownership. */
export async function resolveMetaTransport(
  db: SupabaseClient,
  accountId: string,
): Promise<ResolvedMetaTransport> {
  const { data: connection, error: connectionError } = await db
    .from('whatsapp_connections')
    .select('id, account_id, provider, provider_external_id')
    .eq('account_id', accountId)
    .eq('provider', 'meta_cloud')
    .maybeSingle()

  if (connectionError || !connection) {
    throw new WhatsAppTransportError(
      'authentication_or_configuration',
      'Meta WhatsApp connection not configured for this account',
      connectionError,
    )
  }

  const metaConnection = connection as MetaConnectionRow
  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('id, account_id, phone_number_id, access_token')
    .eq('account_id', accountId)
    .maybeSingle()

  if (configError || !config) {
    throw new WhatsAppTransportError(
      'authentication_or_configuration',
      'WhatsApp not configured for this account',
      configError,
    )
  }

  const metaConfig = config as MetaConfigRow
  if (metaConnection.account_id !== accountId || metaConfig.account_id !== accountId) {
    throw new WhatsAppTransportError(
      'authentication_or_configuration',
      'Resolved Meta WhatsApp configuration is outside the requested account',
    )
  }
  if (
    metaConnection.provider_external_id &&
    metaConnection.provider_external_id !== metaConfig.phone_number_id
  ) {
    throw new WhatsAppTransportError(
      'authentication_or_configuration',
      'Meta connection identity does not match the configured phone number',
    )
  }

  const accessToken = decrypt(metaConfig.access_token)
  if (isLegacyFormat(metaConfig.access_token)) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', metaConfig.id)
      .eq('account_id', accountId)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) console.warn('[meta-adapter] access_token GCM upgrade failed:', error.message)
      })
  }

  return {
    connectionId: metaConnection.id,
    transport: new MetaWhatsAppTransport(
      accountId,
      metaConnection.id,
      metaConfig.phone_number_id,
      accessToken,
    ),
  }
}
