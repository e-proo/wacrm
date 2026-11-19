/** OW14-W04: independent, authenticated TEST watchdog endpoint.
 * Intended for an EXTERNAL monitor, not for the Task scheduler itself.
 * No tenant identifiers, messages, credentials or raw error details are returned.
 */
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { evaluateSchedulerPulse } from '@/lib/ai/tasks/scheduler-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0' }

function authenticated(value: string | null, secret: string): boolean {
  const expected = Buffer.from('Bearer ' + secret)
  const supplied = Buffer.from(value ?? '')
  return expected.length === supplied.length && timingSafeEqual(expected, supplied)
}

export async function GET(request: Request) {
  if (!isOpenWATestProject()) {
    return NextResponse.json({ error: 'TEST only' }, { status: 403, headers })
  }
  const secret = process.env.WACRM_MONITOR_SECRET
  if (!secret || secret.length < 32) {
    return NextResponse.json({ error: 'Monitor not configured' }, { status: 503, headers })
  }
  if (!authenticated(request.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })
  }
  try {
    const { data, error } = await supabaseAdmin()
      .from('ai_agent_task_scheduler_heartbeat')
      .select('last_started_at,last_succeeded_at,last_failed_at,last_result,consecutive_failures,tick_count')
      .eq('runner', 'test_agent_task').maybeSingle()
    if (error) throw error
    const pulse = evaluateSchedulerPulse(data && {
      runnerLastStartedAt: data.last_started_at,
      runnerLastSucceededAt: data.last_succeeded_at,
      runnerLastFailedAt: data.last_failed_at,
      runnerLastResult: data.last_result,
      runnerConsecutiveFailures: data.consecutive_failures,
      runnerTickCount: data.tick_count,
    })
    const healthy = pulse.state === 'healthy'
    return NextResponse.json({
      state: pulse.state,
      reason: pulse.reason,
      age_seconds: pulse.secondsSinceSuccess,
      threshold_seconds: pulse.stopAfterSeconds,
      // 503 signals the independent monitor to page on its configured route.
    }, { status: healthy ? 200 : 503, headers })
  } catch {
    return NextResponse.json({ state: 'unknown', reason: 'monitor_read_failed' },
      { status: 503, headers })
  }
}
