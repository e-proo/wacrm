import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { processAgentTaskTriggerQueue } from '@/lib/ai/tasks/trigger-worker'
import { processAgentTaskQueue } from '@/lib/ai/tasks/orchestrator'
import { processAgentTaskOutboundRunQueue } from '@/lib/ai/tasks/outbound-worker'
import { supabaseAdmin } from '@/lib/ai/admin-client'

export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'Cache-Control': 'private, no-store' }
const MAX_PER_STAGE = 2

function authorized(value: string | null, secret: string): boolean {
  const expected = Buffer.from('Bearer ' + secret)
  const actual = Buffer.from(value ?? '')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * Dedicated TEST-only task queue tick. Does NOT process approved Change
 * Requests, normal CRM event notifications or inbound agent recovery.
 * Every outbound attempt still requires the existing Task/connection grants,
 * policy, recipient Pilot admission, reservations and reconciliation.
 */
export async function POST(request: Request) {
  if (!isOpenWATestProject()) {
    return NextResponse.json({error:'TEST only'}, {status:403,headers})
  }
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({error:'Worker secret missing'}, {status:503,headers})
  if (!authorized(request.headers.get('authorization'),secret)) {
    return NextResponse.json({error:'Unauthorized'}, {status:401,headers})
  }
  const db = supabaseAdmin()
  const owner = crypto.randomUUID()
  const workerId = 'test-task-auto:' + owner
  let ownsTick = false
  let claimed = 0
  let completed = 0
  let failed = 0
  let dead = 0
  try {
    // SCH-4: a shared durable lease prevents two HTTP instances or the local
    // dev timer + a remote cron from processing the same full tick in parallel.
    // Per-firing leases/Task idempotency remain authoritative after a crash.
    const begin = await db.rpc('begin_agent_task_scheduler_tick', {
      p_owner: owner, p_lease_seconds: 120,
    })
    if (begin.error) throw begin.error
    if (begin.data !== true) {
      return NextResponse.json({busy:true,reason:'SCHEDULER_TICK_IN_PROGRESS'},
        {status:202,headers:{...headers,'Retry-After':'30'}})
    }
    ownsTick = true
    const triggers = await processAgentTaskTriggerQueue({
      workerId: workerId + ':triggers', limit: MAX_PER_STAGE,
    })
    claimed = count(triggers.claimed)
    completed = count(triggers.completed)
    failed = count(triggers.failed)
    dead = count(triggers.dead)
    const tasks = await processAgentTaskQueue({
      workerId, limit: MAX_PER_STAGE,
    })
    const outbound = await processAgentTaskOutboundRunQueue({
      workerId: workerId + ':outbound', limit: MAX_PER_STAGE,
    })
    const finish = await db.rpc('finish_agent_task_scheduler_tick', {
      p_owner:owner, p_success:true, p_claimed:claimed,
      p_completed:completed,p_failed:failed,p_dead:dead,
    })
    if (finish.error) throw finish.error
    if (finish.data !== true) throw new Error('SCHEDULER_TICK_LEASE_LOST')
    ownsTick = false
    return NextResponse.json({triggers,tasks,outbound},{headers})
  } catch {
    if (ownsTick) {
      try {
        // Never release a newer owner's lease, and never persist raw error text.
        const finish = await db.rpc('finish_agent_task_scheduler_tick', {
          p_owner:owner,p_success:false,p_claimed:claimed,
          p_completed:completed,p_failed:failed,p_dead:dead,
        })
        if (finish.error || finish.data !== true) {
          console.error('[TEST Agent Task auto-worker] lease finish unavailable')
        }
      } catch {
        console.error('[TEST Agent Task auto-worker] failure checkpoint unavailable')
      }
    }
    console.error('[TEST Agent Task auto-worker] tick failed (redacted)')
    return NextResponse.json({error:'Worker tick failed'}, {status:500,headers})
  }
}

/** Bounded numeric telemetry, never task details/PII/transport payloads. */
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.trunc(value)))
}
