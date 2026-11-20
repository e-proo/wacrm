import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

/**
 * Confirmed local policy denial before any provider network call.
 * Safe for the worker's no-provider-dispatch outcome handling; unlike a
 * provider timeout it must not be classified as an ambiguous send.
 */
export class OpenWAPreDispatchDenied extends WhatsAppTransportError {
  readonly providerDispatchAttempted = false as const
  readonly denialReason: string | null
  constructor(message: string, denialReason: string | null = null) {
    super('connection_restricted', message)
    this.denialReason = denialReason
  }
}
