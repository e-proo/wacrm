// ============================================================
// Coverage service auto-provisioning.
//
// Every coverage row carries a service_id: the schema makes it
// NOT NULL and the atomic booking RPC gates on offer.service_id =
// request.service_id. Requiring the operator to author catalog
// entries first was wrong, so the coverage POST routes resolve
// (or create) the account's dedicated 'coverage' service
// server-side. Same identity as the SQL seed in migration 060:
// category slug 'coverage' → service code 'coverage'.
//
// Race-safe: the service INSERT may hit the (account_id, code)
// unique index if a concurrent request created it — we re-select
// in that case and return the winner's id.
// ============================================================

import { supabaseAdmin } from '@/lib/ai/admin-client'
import { ServiceError } from '@/lib/services/domain-services'

export async function ensureCoverageService(accountId: string): Promise<string> {
  const db = supabaseAdmin()

  // 1) Already provisioned? (the normal path after migration 060)
  const { data: existing, error: svcErr } = await db
    .from('services')
    .select('id, code')
    .eq('account_id', accountId)
    .eq('code', 'coverage')
    .maybeSingle()
  if (svcErr) {
    throw new ServiceError('COVERAGE_SERVICE_READ_FAILED', 'Could not look up the coverage service.', 500)
  }
  if (existing) return existing.id as string

  // 2) Find or create the 'coverage' category.
  const { data: cat, error: catReadErr } = await db
    .from('service_categories')
    .select('id')
    .eq('account_id', accountId)
    .eq('slug', 'coverage')
    .maybeSingle()
  if (catReadErr) {
    throw new ServiceError('COVERAGE_SERVICE_READ_FAILED', 'Could not look up the coverage category.', 500)
  }
  let categoryId = cat?.id as string | undefined
  if (!categoryId) {
    const { data: createdCat, error: catErr } = await db
      .from('service_categories')
      .insert({ account_id: accountId, slug: 'coverage', name: 'التغطية', status: 'active' })
      .select('id')
      .single()
    if (catErr || !createdCat) {
      console.error('[ensureCoverageService] category create failed:', catErr)
      throw new ServiceError('COVERAGE_SERVICE_CREATE_FAILED', 'Could not create the coverage category.', 500)
    }
    categoryId = createdCat.id as string
  }

  // 3) Create the service; on a unique-index race, re-select.
  const { data: created, error: svcCreateErr } = await db
    .from('services')
    .insert({
      account_id: accountId,
      category_id: categoryId,
      code: 'coverage',
      slug: 'coverage',
      name: 'التغطية',
      status: 'active',
    })
    .select('id')
    .single()
  if (svcCreateErr || !created) {
    const code = (svcCreateErr as { code?: string } | null)?.code
    if (code === '23505') {
      const { data: winner, error: reErr } = await db
        .from('services')
        .select('id')
        .eq('account_id', accountId)
        .eq('code', 'coverage')
        .maybeSingle()
      if (reErr || !winner) {
        throw new ServiceError('COVERAGE_SERVICE_CREATE_FAILED', 'Coverage service race lost and re-read failed.', 500)
      }
      return winner.id as string
    }
    console.error('[ensureCoverageService] service create failed:', svcCreateErr)
    throw new ServiceError('COVERAGE_SERVICE_CREATE_FAILED', 'Could not create the coverage service.', 500)
  }
  return created.id as string
}
