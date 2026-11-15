import { NextResponse } from 'next/server'
import { assertAgentCapability, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  inspectAgentTaskTestCutoverReadiness,
  setAgentTaskTestCutoverMode,
} from '@/lib/ai/tasks/cutover'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'

const noStore = { 'Cache-Control': 'private, no-store, max-age=0' }

function deny(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status, headers: noStore })
}

async function authorize(action: 'read' | 'write') {
  // The cutover is an account-wide outbound delivery gate, not a per-agent setting.
  // Both a real account administrator and the fine-grained task capability are required.
  const ctx = await requireRole('admin')
  assertAgentCapability(ctx, 'agents.manage_tasks')
  const limit = checkRateLimit(
    `admin:agentTaskCutover:${action}:${ctx.userId}`,
    RATE_LIMITS.adminAction,
  )
  if (!limit.success) return { blocked: rateLimitResponse(limit), ctx: null }
  return { blocked: null, ctx }
}

/**
 * TEST-only view of the *existing* Phase 18 atomic cutover controls.
 * Never expose service-role credentials, nor mutate a flag directly.
 */
export async function GET() {
  try {
    const { ctx, blocked } = await authorize('read')
    if (blocked) return blocked
    if (!ctx) return deny('Administrator access required.', 'FORBIDDEN', 403)
    if (!isOpenWATestProject()) {
      return deny('Agent Task Pilot controls are available only on TEST.', 'TEST_ONLY', 403)
    }
    const readiness = await inspectAgentTaskTestCutoverReadiness({ accountId: ctx.accountId })
    return NextResponse.json({ environment: 'TEST', readiness }, { headers: noStore })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    const { ctx, blocked } = await authorize('write')
    if (blocked) return blocked
    if (!ctx) return deny('Administrator access required.', 'FORBIDDEN', 403)
    if (!isOpenWATestProject()) {
      return deny('Agent Task Pilot controls are available only on TEST.', 'TEST_ONLY', 403)
    }

    const body: unknown = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return deny('Invalid cutover request.', 'INVALID_REQUEST', 400)
    }
    const value = body as Record<string, unknown>
    const mode = value.mode
    if (mode !== 'pilot' && mode !== 'disabled') {
      return deny('Invalid cutover mode.', 'INVALID_MODE', 400)
    }
    const confirmation = mode === 'pilot'
      ? 'ENABLE_TEST_AGENT_TASK_PILOT'
      : 'DISABLE_TEST_AGENT_TASK_PILOT'
    if (value.confirmation !== confirmation) {
      return deny('Explicit TEST confirmation is required.', 'CONFIRMATION_REQUIRED', 400)
    }

    const before = await inspectAgentTaskTestCutoverReadiness({ accountId: ctx.accountId })
    if (mode === 'pilot' && (before.mode !== 'disabled' || !before.ready || before.blockers.length > 0)) {
      return NextResponse.json(
        { error: 'TEST pilot readiness did not pass.', code: 'CUTOVER_NOT_READY', readiness: before },
        { status: 409, headers: noStore },
      )
    }
    // The database transaction re-checks readiness and atomically updates the
    // runtime outbound flag + WhatsApp scope. 'disabled' is emergency rollback,
    // permitted even while other preflight blockers are present.
    try {
      const change = await setAgentTaskTestCutoverMode({
        accountId: ctx.accountId,
        mode,
        actorId: ctx.userId,
      })
      return NextResponse.json(
        { environment: 'TEST', readiness: change.after, changed: change.changed },
        { headers: noStore },
      )
    } catch (error) {
      console.error('[agent-task-cutover] atomic mode change rejected', error)
      return deny(
        'Cutover was not changed. Recheck TEST readiness and server diagnostics.',
        'CUTOVER_CHANGE_REJECTED',
        409,
      )
    }
  } catch (error) {
    return toErrorResponse(error)
  }
}
