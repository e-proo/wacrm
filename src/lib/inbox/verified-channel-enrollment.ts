import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { verifyPhoneNumber } from '@/lib/whatsapp/meta-api'
import { resolveOpenWAClient } from '@/lib/whatsapp/transport/openwa/credentials'
import { normalizeOpenWAConnectionState } from '@/lib/whatsapp/transport/openwa/session-lifecycle'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'
import { InboxNamespaceEnrollmentError, verifyOpenWANativeContract, type OpenWANativeContract } from './openwa-native-contract'

const notVerified = () => new WhatsAppTransportError('connection_restricted', 'The exact connected sender identity could not be verified. Refresh the connection and try again.')
export function strictOwnPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const phone = value.replace(/^\+/, '')
  return /^[1-9][0-9]{6,14}$/.test(phone) ? phone : null
}

// Caller must authorize admin, pin TEST, and obtain accountId/actorId from
// session. No caller-provided phone, gateway URL, credentials or proof accepted.
export async function enrollVerifiedInboxChannel(db: SupabaseClient, input: {
  accountId: string; actorId: string; connectionId: string; makePrimary: boolean
}) {
  const { accountId, actorId, connectionId, makePrimary } = input
  const { data: c, error } = await db.from('whatsapp_connections')
    .select('id,provider,status,session_id,instance_id,phone_identity,provider_external_id,updated_at')
    .eq('account_id', accountId).eq('id', connectionId).is('archived_at', null).maybeSingle()
  if (error || !c || !['ready','connected'].includes(c.status)) throw notVerified()
  let identity: string
  let credentialVersion: string
  let session: string | null = null
  let instance: string | null = null
  let nativeContract: OpenWANativeContract | null = null
  const checkedAt = new Date().toISOString()
  if (c.provider === 'openwa') {
    const { data: credential, error: credentialError } = await db.from('whatsapp_connection_credentials')
      .select('updated_at').eq('account_id', accountId).eq('connection_id', connectionId).eq('provider','openwa').maybeSingle()
    if (credentialError || !credential || !c.session_id) throw notVerified()
    const { client, credentials } = await resolveOpenWAClient(db, accountId, connectionId, { timeoutMs: 8000 })
    const status = await client.getSessionStatus(c.session_id, connectionId)
    const phone = strictOwnPhone(status.phoneIdentity)
    const observedInstance = typeof status.raw?.instanceId === 'string' ? status.raw.instanceId : null
    if (status.sessionId !== c.session_id || !['ready','connected'].includes(normalizeOpenWAConnectionState(status.status))
        || !phone || phone !== strictOwnPhone(c.phone_identity)
        || (c.instance_id !== null && c.instance_id !== observedInstance)
        || (c.instance_id === null && observedInstance !== null)) throw notVerified()
    identity = phone
    session = c.session_id
    instance = c.instance_id
    credentialVersion = credential.updated_at
    if (makePrimary) {
      if (!credentials.webhookSecret || !credentials.webhookUrl) throw new InboxNamespaceEnrollmentError('namespace_webhook_unconfigured')
      nativeContract = await verifyOpenWANativeContract(client, status, connectionId)
    }
  } else if (c.provider === 'meta_cloud') {
    const { data: config, error: configError } = await db.from('whatsapp_config')
      .select('phone_number_id,access_token,updated_at').eq('account_id', accountId).maybeSingle()
    if (configError || !config || !/^[0-9]{1,32}$/.test(config.phone_number_id)
      || c.provider_external_id !== config.phone_number_id) throw notVerified()
    const result = await verifyPhoneNumber({ phoneNumberId: config.phone_number_id, accessToken: decrypt(config.access_token) })
    if (result.id !== config.phone_number_id) throw notVerified()
    identity = result.id
    credentialVersion = config.updated_at
  } else throw notVerified()
  if (nativeContract) {
    const { data, error: writeError } = await db.rpc('inbox_enroll_verified_openwa_namespace', {
      p_account: accountId, p_actor: actorId, p_connection: connectionId, p_identity: identity,
      p_session: session, p_instance: instance, p_connection_version: c.updated_at,
      p_credential_version: credentialVersion, p_checked_at: checkedAt, p_evidence_ref: randomUUID(),
      p_engine: nativeContract.engine, p_gateway_version: nativeContract.version,
    })
    if (writeError?.message === 'INBOX_NAMESPACE_HANDOVER_REQUIRES_PROOF') throw new InboxNamespaceEnrollmentError('namespace_handover_requires_proof')
    if (writeError || !data || data.namespace_verified !== true || data.primary !== true) throw new InboxNamespaceEnrollmentError('namespace_enrollment_failed')
    return { channelId: data.channel_id as string, membershipId: data.membership_id as string, primary: true, namespaceVerified: true, namespaceScope: nativeContract.scope, engine: nativeContract.engine, gatewayVersion: nativeContract.version }
  }
  const { data, error: writeError } = await db.rpc('inbox_enroll_verified_channel', {
    p_account: accountId, p_actor: actorId, p_connection: connectionId, p_provider: c.provider,
    p_identity: identity, p_session: session, p_instance: instance, p_connection_version: c.updated_at,
    p_credential_version: credentialVersion, p_checked_at: checkedAt, p_evidence_ref: randomUUID(), p_primary: makePrimary,
  })
  if (writeError || !data) throw notVerified()
  return { channelId: data.channel_id as string, membershipId: data.membership_id as string, primary: data.primary === true, namespaceVerified: false }
}
