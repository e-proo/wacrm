/**
 * Native OpenWA evidence probe: the SAME verified session and native ID.
 * Read-only. No delivery claim, no status DB write, no WhatsApp send.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveOpenWAClient } from './credentials'
import {
  parseNativeArchive, safeEvidence, validGatewayReference,
  verifiedGatewaySession, type NativeAckEvidence,
} from './native-ack-evidence'

export interface AckConnectionBinding {
  session_id: string | null
  phone_identity: string | null
  instance_id: string | null
  status: string
}
export interface AckDeferredBinding {
  session_id: string
  own_phone_identity: string | null
  instance_id: string | null
  provider_message_id: string
}

/** Checked in both GET preview and POST disposition; browser claims are NEVER evidence. */
export async function inspectOpenWANativeAck(
  db: SupabaseClient,
  accountId: string,
  connectionId: string,
  connection: AckConnectionBinding,
  job: AckDeferredBinding,
): Promise<NativeAckEvidence> {
  if (!connection.session_id || !['ready','connected'].includes(connection.status) ||
      connection.session_id !== job.session_id ||
      connection.phone_identity !== job.own_phone_identity ||
      connection.instance_id !== job.instance_id) {
    return safeEvidence('session_identity_unverified')
  }
  if (!validGatewayReference(job.provider_message_id)) {
    return safeEvidence('native_reference_unsupported')
  }
  const { client } = await resolveOpenWAClient(db,accountId,connectionId,{timeoutMs:7000})
  const gateway = await client.getSessionStatus(job.session_id)
  if (!verifiedGatewaySession(gateway,job.session_id,job.own_phone_identity)) {
    return safeEvidence('session_identity_unverified')
  }
  const path = '/api/sessions/' + encodeURIComponent(job.session_id) +
    '/messages?messageId=' + encodeURIComponent(job.provider_message_id) +
    '&direction=outgoing&limit=2&inlineMedia=false'
  const archive = await client.request<unknown>(path,{timeoutMs:7000})
  return parseNativeArchive(archive,job.provider_message_id,job.session_id)
}
