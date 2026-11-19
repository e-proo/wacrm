/**
 * OW14-W05: read-only, exact provider-native ID triage.
 * "candidate" means a stored WACRM row shares an exact identifier, NOT
 * provider-delivery proof or authorization to settle/re-send a message.
 */
export type AckLocalCorrelation =
  | 'needs_native_review'
  | 'candidate_outbound_message'
  | 'candidate_broadcast_recipient'
  | 'inbound_only'
  | 'ambiguous_local_rows'

type LocalMessage = { provider_message_id: string | null; sender_type: string | null }
type LocalRecipient = { provider_message_id: string | null }

export function classifyAckLocalCorrelation(
  nativeMessageId: string,
  messages: readonly LocalMessage[],
  recipients: readonly LocalRecipient[],
): AckLocalCorrelation {
  if (!nativeMessageId) return 'needs_native_review'
  const exactMessages = messages.filter(row => row.provider_message_id === nativeMessageId)
  const exactRecipients = recipients.filter(row => row.provider_message_id === nativeMessageId)
  const outbound = exactMessages.filter(row => row.sender_type !== 'customer')
  const inbound = exactMessages.length - outbound.length
  // Multiple rows or inbound+outbound claims are not conclusive evidence.
  if (exactMessages.length + exactRecipients.length > 1) return 'ambiguous_local_rows'
  if (outbound.length === 1) return 'candidate_outbound_message'
  if (exactRecipients.length === 1) return 'candidate_broadcast_recipient'
  if (inbound === 1) return 'inbound_only'
  return 'needs_native_review'
}
