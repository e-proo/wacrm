import { OpenWAPreDispatchDenied } from '@/lib/whatsapp/transport/guardrails'

export interface ReservedOutboundEvidence {
  id: string
  status: string
  message_id: string | null
  provider_message_id: string | null
}

/**
 * A local reservation only means a record was written, not that the gateway
 * accepted the message. WACRM's branded denial certifies the transport was
 * NOT called, but only after DB finalization marks the reservation failed
 * with both provider IDs absent can the durable event be safely failed.
 * Unknown DB lookup errors always require reconciliation.
 */
export function classifyBusinessOutboundFailure(input: {
  error: unknown
  reservation: ReservedOutboundEvidence | null
  reservationLookupFailed?: boolean
}): { status: 'failed' | 'requires_reconciliation'; reason: string } {
  const { error, reservation, reservationLookupFailed } = input
  if (!reservationLookupFailed && error instanceof OpenWAPreDispatchDenied &&
      (!reservation || (reservation.status === 'failed' &&
        !reservation.message_id && !reservation.provider_message_id))) {
    return {
      status: 'failed',
      reason: 'OPENWA_PRE_DISPATCH_DENIED:' + (error.denialReason ?? 'policy'),
    }
  }
  return {
    status: reservation || reservationLookupFailed ? 'requires_reconciliation' : 'failed',
    reason: error instanceof Error ? error.message.slice(0, 1000) : 'BUSINESS_EVENT_DELIVERY_FAILED',
  }
}
