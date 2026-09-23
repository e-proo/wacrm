import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../../../../supabase/migrations/086_fx_v2_trade_admin_review_loop.sql', import.meta.url),
  'utf8',
)
const adminTool = readFileSync(
  new URL('../../ai/tools/fx-v2-admin-tools.ts', import.meta.url),
  'utf8',
)

describe('FX trade reject review contract', () => {
  it('reuses the customer-created review for both approve and reject decisions', () => {
    expect(adminTool).toContain('const reusableReview =')
    expect(adminTool).toContain("reviewPayload?.decision === 'approve'")
    expect(adminTool).not.toContain(
      "args.decision === 'approve' && existingReview?.status === 'pending'",
    )
    expect(adminTool).toContain("code: 'FX_TRADE_REVIEW_CONFLICT'")
  })

  it('rejects the review and the FX trade atomically with the same Change Request id', () => {
    expect(migration).toContain("v_row.target_type = 'fx_trade_request'")
    expect(migration).toContain(
      "coalesce(v_row.proposed_payload->>'decision', '') <> 'approve'",
    )
    expect(migration).toContain('perform public.decide_exchange_trade_request_v2(')
    expect(migration).toContain("'pending_admin'")
    expect(migration).toContain("'reject'")
    expect(migration).toContain('v_row.id')
  })

  it('keeps the rejection RPC service-role only', () => {
    expect(migration).toContain(
      'revoke all on function public.reject_change_request(uuid, uuid, uuid, text)',
    )
    expect(migration).toContain('from public, anon, authenticated')
    expect(migration).toContain('to service_role')
  })
})
