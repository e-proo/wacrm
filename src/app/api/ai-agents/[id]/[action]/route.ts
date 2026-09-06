// ============================================================
// POST /api/ai-agents/[id]/pause|resume|publish-revision
//
// Phase 1 ships:
//   • POST /pause      — sets status=paused. Admin+ only.
//   • POST /resume     — sets status=active. Admin+ only. Requires
//                        a published revision (else 409).
//
// Publish is handled inline by /api/ai-agents POST (auto-publish
// on revision creation). A dedicated publish endpoint lands in
// Phase 3 once the UI separates draft review from publish.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  archiveAgent,
  pauseAgent,
  PublishError,
  resumeAgent,
} from '@/lib/ai/runtime/agents-service'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  try {
    const ctx = await requireRole('admin')

    const limit = checkRateLimit(
      `admin:aiAgentState:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id, action } = await params

    const args = {
      accountId: ctx.accountId,
      agentId: id,
      actorUserId: ctx.userId,
    }

    try {
      if (action === 'pause') {
        const agent = await pauseAgent(ctx.supabase, args)
        return NextResponse.json({ agent })
      }
      if (action === 'resume') {
        const agent = await resumeAgent(ctx.supabase, args)
        return NextResponse.json({ agent })
      }
      if (action === 'archive') {
        const agent = await archiveAgent(ctx.supabase, args)
        return NextResponse.json({ agent })
      }
    } catch (innerErr) {
      if (innerErr instanceof PublishError) {
        return NextResponse.json(
          { error: innerErr.message, code: innerErr.code },
          { status: innerErr.status },
        )
      }
      throw innerErr
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 404 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
