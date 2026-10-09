import { NextResponse } from 'next/server'
import { processAgentRunQueue } from '@/lib/ai/runtime/worker'

export const maxDuration = 60

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const workerId = `cron:${crypto.randomUUID()}`
  const result = await processAgentRunQueue({ workerId, limit: 25 })
  return NextResponse.json(result)
}

export const GET = POST
