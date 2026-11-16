/** Safe, read-only queue progress for account members. No secrets or lease tokens. */
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const { id } = await params
    const { data: broadcast, error } = await supabase.from('broadcasts')
      .select('id').eq('id', id).eq('account_id', accountId).maybeSingle()
    if (error || !broadcast) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    const { data: job, error: jobError } = await supabaseAdmin()
      .from('broadcast_delivery_jobs')
      .select('state,next_attempt_at,paused_reason,last_processed_at')
      .eq('account_id', accountId).eq('broadcast_id', id).maybeSingle()
    if (jobError) throw jobError
    return NextResponse.json({ job }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
