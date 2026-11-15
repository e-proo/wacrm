import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { processAgentTaskTriggerQueue } from '@/lib/ai/tasks/trigger-worker'
import { processAgentTaskQueue } from '@/lib/ai/tasks/orchestrator'
import { processAgentTaskOutboundRunQueue } from '@/lib/ai/tasks/outbound-worker'

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
  const workerId = 'test-task-auto:' + crypto.randomUUID()
  try {
    const triggers = await processAgentTaskTriggerQueue({
      workerId: workerId + ':triggers', limit: MAX_PER_STAGE,
    })
    const tasks = await processAgentTaskQueue({
      workerId, limit: MAX_PER_STAGE,
    })
    const outbound = await processAgentTaskOutboundRunQueue({
      workerId: workerId + ':outbound', limit: MAX_PER_STAGE,
    })
    return NextResponse.json({triggers,tasks,outbound},{headers})
  } catch (error) {
    console.error('[TEST Agent Task auto-worker] tick failed', error)
    return NextResponse.json({error:'Worker tick failed'}, {status:500,headers})
  }
}
