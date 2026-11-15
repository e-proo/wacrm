import type { SupabaseClient } from '@supabase/supabase-js'
import { buildCoverageSupplierCandidates } from './agent-task'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type CoverageContactEligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: 'contact_not_found' | 'not_eligible_supplier' | 'requester_contact' }

/**
 * Supplier history is advisory for an operator-selected CRM contact.
 * Contact existence and tenant scope are mandatory. The downstream SQL
 * still checks suppression, consent/opt-out, budget and transport gates.
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

  const { data: request, error: requestError } = await db.from('coverage_requests')
    .select('id,service_id,requester_contact_id,requested_amount,reserved_amount,fulfilled_amount,currency,attributes,status')
    .eq('account_id', input.accountId).eq('id', input.coverageRequestId)
    .maybeSingle()
  if (requestError) throw requestError
  if (!request) return { eligible: false, reason: 'not_eligible_supplier' }
  if (request.requester_contact_id === input.contactId) {
    return { eligible: false, reason: 'requester_contact' }
  }

  // Match old supplier history for advice only; not a business permission.
  // Resolve per explicit contact BEFORE LIMIT to avoid hiding older offers.
  const { data: offers, error: offersError } = await db.from('coverage_offers')
    .select('provider_contact_id,attributes,status,created_at')
    .eq('account_id', input.accountId)
    .eq('service_id', request.service_id).eq('currency', request.currency)
    .eq('provider_contact_id', input.contactId)
    .in('status', ['active','partially_reserved','fully_reserved','fulfilled','expired'])
    .order('created_at', { ascending: false }).limit(1000)
  if (offersError) throw offersError
  const matches = buildCoverageSupplierCandidates(
    request as Parameters<typeof buildCoverageSupplierCandidates>[0],
    (offers ?? []) as Parameters<typeof buildCoverageSupplierCandidates>[1],
    input.coverageRegionIds ?? [],
    input.contactId,
  )
  return matches.length
    ? { eligible: true }
    : { eligible: false, reason: 'not_eligible_supplier' }
}
