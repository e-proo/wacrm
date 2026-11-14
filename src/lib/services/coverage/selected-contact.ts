import type { SupabaseClient } from '@supabase/supabase-js'
import { COVERAGE_SUPPLIER_CANDIDATE_RESOLVER } from './agent-task'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type CoverageContactEligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: 'contact_not_found' | 'not_eligible_supplier' }

/**
 * A task-level selected contact is a restriction on the normal Coverage
 * supplier history resolver; it is NOT an alternate source of supplier
 * candidates. This preserves matching, tenant isolation and request scope.
 *
 * The downstream materialization RPC still independently checks suppression,
 * consent/opt-out, tags, budget, cooldown and account/channel gates.
 */
export async function checkCoverageSelectedContactEligibility(
  db: SupabaseClient,
  input: {
    accountId: string
    coverageRequestId: string
    contactId: string
    coverageRegionIds?: readonly string[]
  },
): Promise<CoverageContactEligibilityResult> {
  if (!UUID_RE.test(input.coverageRequestId) || !UUID_RE.test(input.contactId)) {
    return { eligible: false, reason: 'contact_not_found' }
  }
  const { data: contact, error: contactError } = await db.from('contacts')
    .select('id')
    .eq('account_id', input.accountId)
    .eq('id', input.contactId)
    .maybeSingle()
  if (contactError) throw contactError
  if (!contact) return { eligible: false, reason: 'contact_not_found' }

  const candidates = await COVERAGE_SUPPLIER_CANDIDATE_RESOLVER.resolve(db, {
    accountId: input.accountId,
    taskId: 'eligibility-preview',
    taskType: 'coverage.sourcing',
    taskTypeVersion: 2,
    taskContext: { coverageRequestId: input.coverageRequestId },
    targetPolicy: {
      selectedContactId: input.contactId,
      coverageRegionIds: [...(input.coverageRegionIds ?? [])],
    },
    maxCandidates: 1,
  })
  return candidates.some((candidate) => candidate.contactId === input.contactId)
    ? { eligible: true }
    : { eligible: false, reason: 'not_eligible_supplier' }
}
