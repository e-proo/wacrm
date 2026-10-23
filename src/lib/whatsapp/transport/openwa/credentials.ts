import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'
import { WhatsAppTransportError } from '../types'
import { OpenWAClient, type OpenWAClientConfig } from './client'

interface OpenWAConnectionRow {
  id: string
  account_id: string
  provider: 'openwa'
}

interface OpenWACredentialRow {
  connection_id: string
  account_id: string
  provider: 'openwa'
  base_url: string
  api_key_encrypted: string
  webhook_secret_encrypted: string | null
}

export interface ResolvedOpenWACredentials {
  accountId: string
  connectionId: string
  baseUrl: string
  apiKey: string
  webhookSecret?: string
}

export async function resolveOpenWACredentials(
  db: SupabaseClient,
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

  const scopedConnection = connection as OpenWAConnectionRow
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

  const scopedCredential = credential as OpenWACredentialRow
  if (scopedCredential.connection_id !== scopedConnection.id || scopedCredential.account_id !== accountId) {
    throw new WhatsAppTransportError('authentication_or_configuration', 'OpenWA credential scope mismatch')
  }

  try {
    return {
      accountId,
      connectionId,
      baseUrl: scopedCredential.base_url,
      apiKey: decrypt(scopedCredential.api_key_encrypted),
      webhookSecret: scopedCredential.webhook_secret_encrypted ? decrypt(scopedCredential.webhook_secret_encrypted) : undefined,
    }
  } catch (error) {
    throw new WhatsAppTransportError('authentication_or_configuration', 'OpenWA credentials could not be decrypted', error)
  }
}

export async function resolveOpenWAClient(
  db: SupabaseClient,
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
