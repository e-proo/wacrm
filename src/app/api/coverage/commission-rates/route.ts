// ============================================================
// /api/coverage/commission-rates — the published commission
// RATE BOARD (migration 062).
//
// GET  — the current card + the most recent history (member+).
// POST — publish a NEW card version (admin+): inserts the new
//        row as current and demotes every previous card. Rows
//        are append-only — the old versions stay for audit.
//
// Rates are per-1000 (7 = 7,000 per 1,000,000), same unit as
// coverage_offers.commission_per_thousand. Null field = "not
// published" (the agent must not state a number for it).
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { parseDecimal } from '@/lib/services/pricing/decimal'

const CARD_SELECT =
  'id, account_id, north_cash, north_remit, north_coverage, south_cash, south_remit, south_coverage, intl_cash, intl_remit, intl_coverage, notes, is_current, created_by, created_at'

const RATE_FIELDS = [
  'northCash',
  'northRemit',
  'northCoverage',
  'southCash',
  'southRemit',
  'southCoverage',
  'intlCash',
  'intlRemit',
  'intlCoverage',
] as const

interface CardBody {
  northCash?: string | number | null
  northRemit?: string | number | null
  northCoverage?: string | number | null
  southCash?: string | number | null
  southRemit?: string | number | null
  southCoverage?: string | number | null
  intlCash?: string | number | null
  intlRemit?: string | number | null
  intlCoverage?: string | number | null
  notes?: string | null
}

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const limit = checkRateLimit(
      `member:coverageRatesGet:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { data, error } = await ctx.supabase
      .from('coverage_commission_cards')
      .select(CARD_SELECT)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(21)
    if (error) {
      console.error('[GET /api/coverage/commission-rates] error:', error)
      return NextResponse.json({ error: 'Failed to load rates' }, { status: 500 })
    }
    const rows = data ?? []
    const current = rows.find((r) => (r as { is_current: boolean }).is_current) ?? null
    return NextResponse.json({ current, history: rows })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:coverageRatesPublish:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: CardBody
    try {
      body = (await request.json()) as CardBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const parsed: Record<string, string | null> = {}
    for (const field of RATE_FIELDS) {
      const raw = (body as Record<string, unknown>)[field]
      if (raw === undefined || raw === null || raw === '') {
        // Map camelCase request fields to snake_case columns.
        parsed[
          field
            .replace(/([A-Z])/g, '_$1')
            .toLowerCase()
        ] = null
        continue
      }
      const v = parseDecimal(String(raw))
      // numeric(12,4) — 4 decimals, at most 8 integer digits.
      // Overflow would abort the publish transaction server-side;
      // refuse it here with a clear 400 instead.
      if (!v || v.lt(0) || v.gte(1e8)) {
        return NextResponse.json(
          { error: `${field} must be a number from 0 up to 99,999,999 (rate per 1000)` },
          { status: 400 },
        )
      }
      parsed[
        field
          .replace(/([A-Z])/g, '_$1')
          .toLowerCase()
      ] = v.toString()
    }

    // One RPC = demote-previous + insert-new in a single
    // transaction. A separate update+insert pair could fail half
    // way and leave the account with no current board at all.
    const { data: cardId, error } = await ctx.supabase.rpc(
      'publish_coverage_rate_card',
      {
        p_account_id: ctx.accountId,
        p_card: parsed,
        p_notes: body.notes ? String(body.notes).slice(0, 500) : null,
        p_created_by: ctx.userId,
      },
    )
    if (error || !cardId) {
      console.error('[POST /api/coverage/commission-rates] publish failed:', error)
      return NextResponse.json({ error: 'Failed to publish rates board' }, { status: 500 })
    }
    const { data: card, error: readErr } = await ctx.supabase
      .from('coverage_commission_cards')
      .select(CARD_SELECT)
      .eq('account_id', ctx.accountId)
      .eq('id', cardId as string)
      .maybeSingle()
    if (readErr || !card) {
      console.error('[POST /api/coverage/commission-rates] read-back failed:', readErr)
      return NextResponse.json({ error: 'Failed to load the published card' }, { status: 500 })
    }
    return NextResponse.json({ card })
  } catch (err) {
    return toErrorResponse(err)
  }
}
