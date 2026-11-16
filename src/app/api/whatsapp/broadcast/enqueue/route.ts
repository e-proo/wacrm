/** Agent-authenticated enqueue. Credentials and worker RPCs remain server-only. */
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { BroadcastError } from '@/lib/whatsapp/broadcast-core'
import { enqueueBroadcastDelivery } from '@/lib/whatsapp/broadcast-worker'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const rate = checkRateLimit('broadcast-enqueue:' + userId, RATE_LIMITS.broadcast)
    if (!rate.success) return rateLimitResponse(rate)
    const payload = await request.json().catch(() => null) as Record<string, unknown> | null
    if (typeof payload?.broadcast_id !== 'string' || !UUID.test(payload.broadcast_id) ||
      (payload.header_media_url !== undefined && payload.header_media_url !== null &&
        typeof payload.header_media_url !== 'string')) {
      return NextResponse.json({ error: 'Valid broadcast ID and optional HTTPS media URL required' }, { status: 400 })
    }
    const { data: owned, error: ownError } = await supabase.from('broadcasts')
      .select('id').eq('id', payload.broadcast_id).eq('account_id', accountId).maybeSingle()
    if (ownError || !owned) return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 })
    const queued = await enqueueBroadcastDelivery(supabaseAdmin(), {
      accountId, broadcastId: payload.broadcast_id,
      headerMediaUrl: typeof payload.header_media_url === 'string' ? payload.header_media_url : null,
    })
    return NextResponse.json({
      success: true, broadcast_id: payload.broadcast_id,
      job_id: queued.jobId, state: queued.state, pending: queued.pending,
    }, { status: 202 })
  } catch (error) {
    if (error instanceof BroadcastError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    return toErrorResponse(error)
  }
}
