// ============================================================
// Coverage lifecycle — status transitions + draft edits for
// coverage_offers / coverage_requests.
//
// Fixes the v1 lifecycle gap: rows created through the manual UI
// landed in 'draft' with no activation path, so they were never
// bookable. The transitions here are the ONLY status mutations
// outside the reserve/release RPCs:
//
//   activate: draft → active
//   cancel:   any non-terminal state with NOTHING reserved →
//             cancelled (release matches first otherwise)
//   fulfill:  active / partially_reserved / fully_reserved →
//             fulfilled (manual completion)
//   expire:   active / partially_reserved / fully_reserved →
//             expired
//
// Field edits are allowed only while the row is a pristine draft
// (nothing reserved, nothing fulfilled) — amounts, currency,
// commission, deal_date and attributes.
// ============================================================

import { supabaseAdmin } from '@/lib/ai/admin-client'
import { ServiceError } from '@/lib/services/domain-services'
import { parseDecimal } from '@/lib/services/pricing/decimal'
import { normalizeCoverageAttributes } from './attributes'

const COMMISSION_CURRENCY_RE = /^[A-Z_]{3,8}$/
const DEAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export type CoverageAction =
  | 'activate'
  | 'cancel'
  | 'fulfill'
  | 'expire'

const TERMINAL = new Set(['fulfilled', 'expired', 'cancelled'])

function assertTransition(
  action: CoverageAction,
  status: string,
  reserved: Decimal0,
  tableName: string,
): string {
  if (TERMINAL.has(status)) {
    throw new ServiceError(
      'COVERAGE_ROW_TERMINAL',
      `Row is already ${status}.`,
      409,
    )
  }
  switch (action) {
    case 'activate':
      if (status !== 'draft') {
        throw new ServiceError(
          'COVERAGE_INVALID_TRANSITION',
          `activate requires draft (current: ${status}).`,
          409,
        )
      }
      return 'active'
    case 'cancel':
      if (reserved.reservedAmount > 0) {
        throw new ServiceError(
          'COVERAGE_HAS_RESERVATIONS',
          `Release the ${reserved.reservedAmount} reserved on this ${tableName} before cancelling.`,
          409,
        )
      }
      return 'cancelled'
    case 'fulfill':
    case 'expire':
      if (status === 'draft') {
        throw new ServiceError(
          'COVERAGE_INVALID_TRANSITION',
          `${action} requires an active row (current: draft).`,
          409,
        )
      }
      return action === 'fulfill' ? 'fulfilled' : 'expired'
  }
}

interface Decimal0 {
  reservedAmount: number
  fulfilledAmount: number
}

export interface TransitionInput {
  accountId: string
  rowId: string
  action: CoverageAction
  actorUserId: string
  /** 'coverage_offers' | 'coverage_requests'. */
  table: 'coverage_offers' | 'coverage_requests'
  /** 'offer' | 'request' — used in audit events. */
  targetType: 'coverage_offer' | 'coverage_request'
}

export async function transitionCoverageRow(
  input: TransitionInput,
): Promise<void> {
  const db = supabaseAdmin()
  const { data: row, error } = await db
    .from(input.table)
    .select('id, status, reserved_amount, fulfilled_amount')
    .eq('account_id', input.accountId)
    .eq('id', input.rowId)
    .maybeSingle()
  if (error) {
    throw new ServiceError('COVERAGE_READ_FAILED', 'Could not read the row.', 500)
  }
  if (!row) {
    throw new ServiceError('COVERAGE_ROW_NOT_FOUND', 'Row not found.', 404)
  }
  const reserved = {
    reservedAmount: Number(row.reserved_amount ?? 0),
    fulfilledAmount: Number(row.fulfilled_amount ?? 0),
  }
  const nextStatus = assertTransition(
    input.action,
    row.status as string,
    reserved,
    input.table === 'coverage_offers' ? 'offer' : 'request',
  )

  const { error: updateError } = await db
    .from(input.table)
    .update({ status: nextStatus })
    .eq('account_id', input.accountId)
    .eq('id', input.rowId)
    .eq('status', row.status as string)
  if (updateError) {
    console.error('[transitionCoverageRow] update failed:', updateError)
    throw new ServiceError('COVERAGE_UPDATE_FAILED', 'Could not update the row.', 500)
  }

  await db.rpc('append_service_activity_event', {
    p_account_id: input.accountId,
    p_target_type: input.targetType,
    p_target_id: input.rowId,
    p_event_type: `coverage.${input.action}`,
    p_actor_type: 'user',
    p_actor_id: input.actorUserId,
    p_payload: { from: row.status, to: nextStatus },
  })
}

export interface OfferDraftPatch {
  totalAmount?: string
  currency?: string
  commissionPerThousand?: string | null
  commissionCurrency?: string | null
  dealDate?: string | null
  notes?: string | null
  attributes?: Record<string, unknown>
  availableFrom?: string | null
  expiresAt?: string | null
}

/** Apply a field patch to a PRISTINE DRAFT offer (nothing reserved). */
export async function patchCoverageOfferDraft(
  accountId: string,
  rowId: string,
  patch: OfferDraftPatch,
): Promise<Record<string, unknown>> {
  const db = supabaseAdmin()
  const { data: row, error } = await db
    .from('coverage_offers')
    .select('id, status, reserved_amount, fulfilled_amount')
    .eq('account_id', accountId)
    .eq('id', rowId)
    .maybeSingle()
  if (error || !row) {
    throw new ServiceError('COVERAGE_ROW_NOT_FOUND', 'Offer not found.', 404)
  }
  if (row.status !== 'draft') {
    throw new ServiceError(
      'COVERAGE_NOT_EDITABLE',
      'Only draft offers can be edited.',
      409,
    )
  }
  if (Number(row.reserved_amount) > 0 || Number(row.fulfilled_amount) > 0) {
    throw new ServiceError(
      'COVERAGE_NOT_EDITABLE',
      'Offer has reservations; it can no longer be edited.',
      409,
    )
  }

  const update: Record<string, unknown> = {}
  if (patch.totalAmount !== undefined) {
    const total = parseDecimal(patch.totalAmount, { rejectZero: true })
    if (!total) {
      throw new ServiceError('COVERAGE_INVALID_AMOUNT', 'totalAmount must be > 0.', 400)
    }
    update.total_amount = total.toString()
  }
  if (patch.currency !== undefined) {
    if (!patch.currency) {
      throw new ServiceError('COVERAGE_INVALID_CURRENCY', 'currency is required.', 400)
    }
    update.currency = patch.currency
  }
  if (patch.commissionPerThousand !== undefined) {
    const rate =
      patch.commissionPerThousand === null || patch.commissionPerThousand === ''
        ? null
        : parseDecimal(patch.commissionPerThousand)
    if (patch.commissionPerThousand !== null && patch.commissionPerThousand !== '' && !rate) {
      throw new ServiceError(
        'COVERAGE_INVALID_COMMISSION',
        'commissionPerThousand must be a non-negative number.',
        400,
      )
    }
    update.commission_per_thousand = rate === null ? null : rate.toString()
  }
  if (patch.commissionCurrency !== undefined) {
    const ccy = patch.commissionCurrency
      ? patch.commissionCurrency.trim().toUpperCase()
      : null
    if (ccy && !COMMISSION_CURRENCY_RE.test(ccy)) {
      throw new ServiceError(
        'COVERAGE_INVALID_COMMISSION',
        'commissionCurrency must be 3-8 uppercase letters.',
        400,
      )
    }
    update.commission_currency = ccy
  }
  if (patch.dealDate !== undefined) {
    if (patch.dealDate && !DEAL_DATE_RE.test(patch.dealDate)) {
      throw new ServiceError('COVERAGE_INVALID_DATE', 'dealDate must be YYYY-MM-DD.', 400)
    }
    update.deal_date = patch.dealDate ?? null
  }
  if (patch.notes !== undefined) update.notes = patch.notes ? String(patch.notes).slice(0, 1000) : null
  if (patch.attributes !== undefined) {
    const attrs = normalizeCoverageAttributes(patch.attributes)
    if (!attrs.ok) {
      throw new ServiceError(
        'COVERAGE_INVALID_ATTRIBUTES',
        attrs.errors.map((e) => `${e.field}: ${e.code}`).join('; '),
        400,
      )
    }
    update.attributes = attrs.normalized
  }
  if (patch.availableFrom !== undefined) update.available_from = patch.availableFrom ?? null
  if (patch.expiresAt !== undefined) update.expires_at = patch.expiresAt ?? null

  if (Object.keys(update).length === 0) {
    throw new ServiceError('COVERAGE_EMPTY_PATCH', 'No editable fields supplied.', 400)
  }

  const { data, error: updateError } = await db
    .from('coverage_offers')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', rowId)
    .select(
      'id, reference_code, total_amount, currency, attributes, commission_per_thousand, commission_currency, commission_amount, deal_date, notes, available_from, expires_at, status, version, updated_at',
    )
    .single()
  if (updateError || !data) {
    console.error('[patchCoverageOfferDraft] failed:', updateError)
    throw new ServiceError('COVERAGE_UPDATE_FAILED', 'Could not update the offer.', 500)
  }
  return data
}

export interface RequestDraftPatch {
  requestedAmount?: string
  currency?: string
  commissionPerThousand?: string | null
  commissionCurrency?: string | null
  dealDate?: string | null
  attributes?: Record<string, unknown>
  priority?: 'low' | 'normal' | 'high'
  notes?: string | null
  expiresAt?: string | null
}

/** Apply a field patch to a PRISTINE DRAFT request (nothing reserved). */
export async function patchCoverageRequestDraft(
  accountId: string,
  rowId: string,
  patch: RequestDraftPatch,
): Promise<Record<string, unknown>> {
  const db = supabaseAdmin()
  const { data: row, error } = await db
    .from('coverage_requests')
    .select('id, status, reserved_amount, fulfilled_amount')
    .eq('account_id', accountId)
    .eq('id', rowId)
    .maybeSingle()
  if (error || !row) {
    throw new ServiceError('COVERAGE_ROW_NOT_FOUND', 'Request not found.', 404)
  }
  if (row.status !== 'draft') {
    throw new ServiceError(
      'COVERAGE_NOT_EDITABLE',
      'Only draft requests can be edited.',
      409,
    )
  }
  if (Number(row.reserved_amount) > 0 || Number(row.fulfilled_amount) > 0) {
    throw new ServiceError(
      'COVERAGE_NOT_EDITABLE',
      'Request has reservations; it can no longer be edited.',
      409,
    )
  }

  const update: Record<string, unknown> = {}
  if (patch.requestedAmount !== undefined) {
    const total = parseDecimal(patch.requestedAmount, { rejectZero: true })
    if (!total) {
      throw new ServiceError('COVERAGE_INVALID_AMOUNT', 'requestedAmount must be > 0.', 400)
    }
    update.requested_amount = total.toString()
  }
  if (patch.currency !== undefined) {
    if (!patch.currency) {
      throw new ServiceError('COVERAGE_INVALID_CURRENCY', 'currency is required.', 400)
    }
    update.currency = patch.currency
  }
  if (patch.commissionPerThousand !== undefined) {
    const rate =
      patch.commissionPerThousand === null || patch.commissionPerThousand === ''
        ? null
        : parseDecimal(patch.commissionPerThousand)
    if (patch.commissionPerThousand !== null && patch.commissionPerThousand !== '' && !rate) {
      throw new ServiceError(
        'COVERAGE_INVALID_COMMISSION',
        'commissionPerThousand must be a non-negative number.',
        400,
      )
    }
    update.commission_per_thousand = rate === null ? null : rate.toString()
  }
  if (patch.commissionCurrency !== undefined) {
    const ccy = patch.commissionCurrency
      ? patch.commissionCurrency.trim().toUpperCase()
      : null
    if (ccy && !COMMISSION_CURRENCY_RE.test(ccy)) {
      throw new ServiceError(
        'COVERAGE_INVALID_COMMISSION',
        'commissionCurrency must be 3-8 uppercase letters.',
        400,
      )
    }
    update.commission_currency = ccy
  }
  if (patch.dealDate !== undefined) {
    if (patch.dealDate && !DEAL_DATE_RE.test(patch.dealDate)) {
      throw new ServiceError('COVERAGE_INVALID_DATE', 'dealDate must be YYYY-MM-DD.', 400)
    }
    update.deal_date = patch.dealDate ?? null
  }
  if (patch.attributes !== undefined) {
    const attrs = normalizeCoverageAttributes(patch.attributes)
    if (!attrs.ok) {
      throw new ServiceError(
        'COVERAGE_INVALID_ATTRIBUTES',
        attrs.errors.map((e) => `${e.field}: ${e.code}`).join('; '),
        400,
      )
    }
    update.attributes = attrs.normalized
  }
  if (patch.priority !== undefined) {
    if (!['low', 'normal', 'high'].includes(patch.priority)) {
      throw new ServiceError('COVERAGE_INVALID_PRIORITY', 'priority is invalid.', 400)
    }
    update.priority = patch.priority
  }
  if (patch.notes !== undefined) update.notes = patch.notes ?? null
  if (patch.expiresAt !== undefined) update.expires_at = patch.expiresAt ?? null

  if (Object.keys(update).length === 0) {
    throw new ServiceError('COVERAGE_EMPTY_PATCH', 'No editable fields supplied.', 400)
  }

  const { data, error: updateError } = await db
    .from('coverage_requests')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', rowId)
    .select(
      'id, requested_amount, currency, attributes, commission_per_thousand, commission_currency, commission_amount, deal_date, priority, notes, expires_at, status, version, updated_at',
    )
    .single()
  if (updateError || !data) {
    console.error('[patchCoverageRequestDraft] failed:', updateError)
    throw new ServiceError('COVERAGE_UPDATE_FAILED', 'Could not update the request.', 500)
  }
  return data
}
