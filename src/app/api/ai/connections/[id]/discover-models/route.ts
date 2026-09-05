import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { refreshCatalog } from '@/lib/ai/connections/catalog'
import { AiError } from '@/lib/ai/types'

const FEATURE_FLAG_ON = process.env.AI_MULTI_PROVIDER_ENABLED === 'true'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/ai/connections/:id/discover-models  (admin+)
 *
 * Explicit user action (FR-MOD-01): authenticate-probe + model list
 * from the SERVER side, using only the stored, validated connection.
 * Never accepts a URL or key from the request body. Fresh cache is
 * served without a provider call unless `force_refresh` is set.
 * A failed refresh keeps (and returns) the last good catalog marked
 * `stale` — and never removes a stored model (ADR-004/006).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    if (!FEATURE_FLAG_ON) {
      return NextResponse.json(
        { error: 'Multi-provider connections are not enabled on this deployment.' },
        { status: 404 },
      )
    }
    const { supabase, accountId, userId } = await requireRole('admin')
    const { id } = await params
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return NextResponse.json({ error: 'Invalid connection id' }, { status: 400 })
    }

    // Separate, stricter bucket than generic admin actions: this one
    // spends provider quota against discovery.
    const limit = checkRateLimit(`ai-discover:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => ({}))
    const force = body && typeof body === 'object' ? body.force_refresh === true : false

    const result = await refreshCatalog(supabase, accountId, id, { force })

    if (result.errorCode) {
      // Contract docs §10: status reflects the operation, stale cache
      // (when present) ships in the same body.
      const retryable =
        result.errorCode === 'AI_RATE_LIMITED' ||
        result.errorCode === 'AI_CONNECTION_TIMEOUT' ||
        result.errorCode === 'AI_PROVIDER_UNAVAILABLE'
      return NextResponse.json(
        {
          catalog: result.catalog,
          stale: true,
          error: {
            code: result.errorCode,
            message: 'Could not refresh models; showing the last successful list.',
            retryable,
          },
        },
        { status: result.catalog ? 200 : 502 },
      )
    }

    return NextResponse.json({
      catalog: result.catalog,
      stale: result.stale,
      verification: {
        connection_ok: result.connectionOk,
        generation_ok: null,
      },
    })
  } catch (err) {
    if (err instanceof AiError && err.code === 'not_found') {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
    }
    return toErrorResponse(err)
  }
}
