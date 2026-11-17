import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { parseScheduleDraft, schedulePreview, ScheduleValidationError } from '@/lib/ai/tasks/schedule-admin'

const headers = { 'Cache-Control': 'private, no-store, max-age=0' }

/** Pure, no-send preview. No materialization, claim or provider calls. */
export async function POST(request: Request) {
  try {
    await requireAgentCapability('agents.manage_tasks')
    const parsed = parseScheduleDraft(await request.json().catch(() => null))
    return NextResponse.json(schedulePreview(parsed), { headers })
  } catch (error) {
    if (error instanceof ScheduleValidationError) {
      return NextResponse.json({ error: error.message, code: error.code },
        { status: 400, headers })
    }
    return toErrorResponse(error)
  }
}
