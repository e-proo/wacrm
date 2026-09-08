// ============================================================
// POST /api/admin/backfill-legacy
//
// One-shot endpoint that runs the Phase 1 backfill for the
// caller's account: copies `ai_configs` (api_key + model + system
// prompt + limits + handoff) into the new `ai_provider_connections`
// + `ai_agents` + `ai_agent_revisions` tables, then publishes
// revision 1 atomically and seeds a default route.
//
// Idempotent — calling it twice for the same account is a no-op
// (the backfill refuses to create a second connection keyed to
// the same legacy config).
//
// Admin+ only.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { backfillAccountFromLegacyConfig } from '@/lib/ai/runtime/backfill-legacy'

export async function POST() {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:backfillLegacy:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const result = await backfillAccountFromLegacyConfig(ctx.accountId)
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
