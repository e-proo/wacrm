/**
 * Legacy per-request batch send has been retired.
 * Returning 410 is intentional: it cannot acquire a durable worker lease,
 * so silently executing it would reintroduce double-send and tab-loss risks.
 */
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
export async function POST() {
  try {
    await requireRole('agent')
    return NextResponse.json({
      code: 'broadcast_worker_required',
      error: 'Direct batch delivery has been replaced by the durable campaign queue.',
    }, { status: 410 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
