// Enqueues pending or proven-unsent recipients. Delivery executes only in the dedicated worker.
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { BroadcastError } from '@/lib/whatsapp/broadcast-core'
import { enqueueBroadcastDelivery, type BroadcastResumeScope } from '@/lib/whatsapp/broadcast-worker'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const rate = checkRateLimit('broadcast-resume:' + userId, RATE_LIMITS.broadcast)
    if (!rate.success) return rateLimitResponse(rate)
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const scope: BroadcastResumeScope = body?.scope === 'failed' ? 'failed' : 'pending'
    if (body?.scope && body.scope !== scope) {
      return NextResponse.json({ error: 'Use pending or proven-unsent failed scope only' }, { status: 400 })
    }
    const { data, error } = await supabase.from('broadcasts')
      .select('id').eq('account_id', accountId).eq('id', id).maybeSingle()
    if (error || !data) return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 })
    const job = await enqueueBroadcastDelivery(supabaseAdmin(), {
      accountId, broadcastId: id, scope,
    })
    return NextResponse.json({
      success: true, broadcast_id: id, job_id: job.jobId,
      state: job.state, resuming: job.pending, remaining: 0, unsendable: 0,
    }, { status: 202 })
  } catch (error) {
    if (error instanceof BroadcastError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    return toErrorResponse(error)
  }
}
