import { decrypt } from '@/lib/whatsapp/encryption'
import { WhatsAppTransportError } from '../types'
import { OpenWAClient, type OpenWAClientConfig } from './client'

interface SupabaseLike {
  from(table: string): any
}

export interface ResolvedOpenWACredentials {
  accountId: string
  connectionId: string
  baseUrl: string
  apiKey: string
  webhookSecret?: string
}

export async function resolveOpenWACredentials(
  db: SupabaseLike,
  accountId: string,
  connectionId: string,
): Promise<ResolvedOpenWACredentials> {
  const { data: connection, error: connectionError } = await db
    .from('whatsapp_connections')
    .select('id, account_id, provider')
    .eq('id', connectionId)
    .eq('account_id', accountId)
    .eq('provider', 'openwa')
    .maybeSingle()

  if (connectionError || !connection) {
    throw new WhatsAppTransportError('authentication_or_configuration', 'OpenWA connection is not configured for this account', connectionError)
  }

  const { data: credential, error: credentialError } = await db
    .from('whatsapp_connection_credentials')
    .select('connection_id, account_id, provider, base_url, api_key_encrypted, webhook_secret_encrypted')
    .eq('connection_id', connectionId)
    .eq('account_id', accountId)
    .eq('provider', 'openwa')
    .maybeSingle()

  if (credentialError || !credential) {
    throw new WhatsAppTransportError('authentication_or_configuration', 'OpenWA credentials are not configured for this connection', credentialError)
  }

  if (credential.connection_id !== connection.id || credential.account_id !== accountId) {
    throw new WhatsAppTransportError('authentication_or_configuration', 'OpenWA credential scope mismatch')
  }

  try {
    return {
      accountId,
      connectionId,
      baseUrl: credential.base_url,
      apiKey: decrypt(credential.api_key_encrypted),
      webhookSecret: credential.webhook_secret_encrypted ? decrypt(credential.webhook_secret_encrypted) : undefined,
    }
  } catch (error) {
    throw new WhatsAppTransportError('authentication_or_configuration', 'OpenWA credentials could not be decrypted', error)
  }
}

export async function resolveOpenWAClient(
  db: SupabaseLike,
  accountId: string,
  connectionId: string,
  options: Pick<OpenWAClientConfig, 'timeoutMs' | 'allowedHosts' | 'fetchImpl'> = {},
): Promise<{ credentials: ResolvedOpenWACredentials; client: OpenWAClient }> {
  const credentials = await resolveOpenWACredentials(db, accountId, connectionId)
  return {
    credentials,
    client: new OpenWAClient({
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      ...options,
    }),
  }
}
