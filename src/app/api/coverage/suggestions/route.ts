// ============================================================
// /api/coverage/suggestions — live matching suggestions between
// ACTIVE coverage offers and requests. Admin+ only.
//
// Suggestions are computed on the fly (never persisted) by the
// pure engine in src/lib/services/coverage/suggestions.ts.
// Booking a suggestion leg still goes through the atomic
// reserve_coverage_match RPC (POST /api/coverage/matches).
//
// GET params:
//   requestId=<id>  — singles + bundle for ONE request
//   offerId=<id>    — ranked consuming requests for ONE offer
//   (none)          — top suggestions for every active request
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  buildCoverageSuggestions,
  type OfferLike,
  type RegionRef,
  type RequestLike,
} from '@/lib/services/coverage/suggestions'

const BOOKABLE = ['active', 'partially_reserved'] as const

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:coverageSuggestions:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const db = supabaseAdmin()
    const url = new URL(request.url)
    const requestId = url.searchParams.get('requestId')
    const offerId = url.searchParams.get('offerId')

    const [offersRes, requestsRes, regionsRes] = await Promise.all([
      db
        .from('coverage_offers')
        .select(
          'id, service_id, provider_contact_id, reference_code, total_amount, reserved_amount, fulfilled_amount, currency, commission_per_thousand, commission_currency, attributes, status',
        )
        .eq('account_id', ctx.accountId)
        .in('status', BOOKABLE),
      db
        .from('coverage_requests')
        .select(
          'id, service_id, requester_contact_id, requested_amount, reserved_amount, fulfilled_amount, currency, attributes, status',
        )
        .eq('account_id', ctx.accountId)
        .in('status', BOOKABLE),
      db
        .from('coverage_regions')
        .select('id, macro_region')
        .eq('account_id', ctx.accountId)
        .eq('status', 'active'),
    ])

    if (offersRes.error || requestsRes.error || regionsRes.error) {
      console.error(
        '[GET /api/coverage/suggestions] read errors:',
        offersRes.error,
        requestsRes.error,
        regionsRes.error,
      )
      return NextResponse.json(
        { error: 'Failed to read coverage rows' },
        { status: 500 },
      )
    }

    const regions = (regionsRes.data ?? []) as RegionRef[]
    const offers = (offersRes.data ?? []) as OfferLike[]
    const requests = (requestsRes.data ?? []) as RequestLike[]
    const { forRequests, forOffers, complementaryPairs } =
      buildCoverageSuggestions(offers, requests, regions)

    if (requestId) {
      const row = forRequests.find((r) => r.request_id === requestId)
      if (!row) {
        return NextResponse.json(
          { error: 'Request not found, not bookable, or fully reserved.' },
          { status: 404 },
        )
      }
      return NextResponse.json(row)
    }

    if (offerId) {
      const candidates = forOffers[offerId] ?? []
      return NextResponse.json({ offer_id: offerId, candidates })
    }

    // Overview: keep every request row but cap the singles list so
    // the payload stays small on busy accounts. Same-type
    // anti-parallel rows (two offers / two requests that are
    // actually opposite sides) surface as complementaryPairs.
    return NextResponse.json({
      suggestions: forRequests.map((row) => ({
        ...row,
        singles: row.singles.slice(0, 3),
      })),
      complementaryPairs,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
