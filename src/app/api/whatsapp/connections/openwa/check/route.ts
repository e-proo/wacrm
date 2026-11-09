import { NextResponse } from 'next/server'

import { OpenWAClient, validateOpenWABaseUrl } from '@/lib/whatsapp/transport/openwa/client'
import { requireOpenWASessionAdmin } from '@/lib/whatsapp/transport/openwa/session-auth'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

// An admin-only read-only gateway check. Never starts a WhatsApp session,
// persists credentials, downloads media, or returns raw provider payloads.
export const maxDuration = 15
const headers = { 'Cache-Control': 'no-store, private, max-age=0' }

export async function POST(request: Request) {
  try {
    await requireOpenWASessionAdmin()
    const body = await request.json() as Record<string, unknown>
    const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : ''
    const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    if (!baseUrl || !apiKey) {
      throw new WhatsAppTransportError('invalid_request', 'OpenWA URL and API key are required')
    }
    const allowedHosts = (process.env.OPENWA_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean)
    const valid = validateOpenWABaseUrl(baseUrl, allowedHosts)
    const client = new OpenWAClient({ baseUrl: valid.toString(), apiKey, allowedHosts, timeoutMs: 8_000 })
    // Read only, using the gateway's existing sessions endpoint. Do not
    // include session identifiers or provider response data in the result.
    await client.request<unknown>('/api/sessions')
    return NextResponse.json({ reachable: true }, { headers })
  } catch (error) {
    const safe = error instanceof WhatsAppTransportError ? error : null
    const code = safe?.code ?? 'retryable_provider_failure'
    const status = code === 'authentication_or_configuration' ? 403
      : code === 'invalid_request' ? 400
      : code === 'rate_limited' ? 429 : 502
    return NextResponse.json({
      reachable: false,
      error: safe?.message ?? 'OpenWA gateway check failed',
      code,
    }, { status, headers })
  }
}
