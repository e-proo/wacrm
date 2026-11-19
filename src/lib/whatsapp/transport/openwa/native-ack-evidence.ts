/**
 * OW14-W05: parse a scoped, read-only OpenWA archive query.
 *
 * The upstream OpenWA GET /api/sessions/:id/messages supports exact messageId,
 * direction=outgoing and inlineMedia=false. Archive rows are NOT proof that
 * WhatsApp delivered a message; absence is NOT proof a send never occurred.
 * Never return raw message objects or native IDs to the browser.
 */
export type NativeAckEvidenceCode =
  | 'archive_outbound_found'
  | 'not_in_gateway_archive'
  | 'ambiguous_gateway_archive'
  | 'unverifiable_gateway_response'
  | 'session_identity_unverified'
  | 'native_reference_unsupported'
  | 'gateway_unavailable'

export type NativeAckEvidence = {
  code: NativeAckEvidenceCode
  archive_status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | null
  whatsapp_delivery_confirmed: false
  outbound_resent: false
}

export function safeEvidence(
  code: NativeAckEvidenceCode,
  archive_status: NativeAckEvidence['archive_status'] = null,
): NativeAckEvidence {
  return { code, archive_status, whatsapp_delivery_confirmed: false, outbound_resent: false }
}

export function validGatewayReference(id: unknown): id is string {
  return typeof id === 'string' && id.length >= 1 && id.length <= 200 &&
    !/\s/.test(id) && !/[\u0000-\u001f\u007f]/.test(id)
}

export function canonicalOwnPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const clean = value.trim().replace(/@(c\.us|s\.whatsapp\.net)$/i, '').replace(/^\+/, '')
  return /^[1-9]\d{6,14}$/.test(clean) ? clean : null
}

/** Do not mistake another account rebound to the same session ID for evidence. */
export function verifiedGatewaySession(
  gateway: { sessionId?: string; status: string; phoneIdentity?: string },
  expectedSession: string,
  expectedPhone: string | null,
): boolean {
  const knownPhone = canonicalOwnPhone(expectedPhone)
  const actualPhone = canonicalOwnPhone(gateway.phoneIdentity)
  return gateway.sessionId === expectedSession &&
    ['ready','connected'].includes(gateway.status.toLowerCase()) &&
    Boolean(knownPhone && actualPhone && knownPhone === actualPhone)
}

export function parseNativeArchive(
  value: unknown,
  exactMessageId: string,
  expectedSession: string,
): NativeAckEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return safeEvidence('unverifiable_gateway_response')
  }
  const data = value as Record<string, unknown>
  if (!Array.isArray(data.messages) || typeof data.total !== 'number' ||
      !Number.isSafeInteger(data.total) || data.total < 0) {
    return safeEvidence('unverifiable_gateway_response')
  }
  if (data.total === 0 && data.messages.length === 0) {
    return safeEvidence('not_in_gateway_archive')
  }
  if (data.total > 1 || data.messages.length > 1) {
    return safeEvidence('ambiguous_gateway_archive')
  }
  if (data.total !== 1 || data.messages.length !== 1) {
    return safeEvidence('unverifiable_gateway_response')
  }
  const row = data.messages[0]
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return safeEvidence('unverifiable_gateway_response')
  }
  const message = row as Record<string, unknown>
  if (message.waMessageId !== exactMessageId ||
      message.sessionId !== expectedSession ||
      message.direction !== 'outgoing') {
    return safeEvidence('unverifiable_gateway_response')
  }
  const statuses = ['pending', 'sent', 'delivered', 'read', 'failed']
  if (typeof message.status !== 'string' || !statuses.includes(message.status)) {
    return safeEvidence('unverifiable_gateway_response')
  }
  return safeEvidence('archive_outbound_found',
    message.status as NativeAckEvidence['archive_status'])
}
