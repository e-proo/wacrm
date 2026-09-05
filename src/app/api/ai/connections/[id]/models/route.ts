import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import type { ConnectionRow } from '@/lib/ai/connections/types'
import { unpackCatalogEnvelope, catalogIsFresh } from '@/lib/ai/providers/normalize'

const FEATURE_FLAG_ON = process.env.AI_MULTI_PROVIDER_ENABLED === 'true'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/ai/connections/:id/models  (member+)
 *
 * READ-ONLY cache hydration for the Settings form: returns the stored
 * normalized catalog (models + fetchedAt) with a `stale` verdict —
 * server-side cache only, NEVER a provider round-trip. This is what
 * lets the model comboboxes fill themselves on open instead of making
 * the admin press Verify first; freshness/TTL/fingerprint logic lives
 * in one place (`catalogIsFresh`) so client and server agree.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    if (!FEATURE_FLAG_ON) {
      return NextResponse.json(
        { error: 'Multi-provider connections are not enabled on this deployment.' },
        { status: 404 },
      )
    }
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params

    const { data, error } = await supabase
      .from('ai_provider_connections')
      .select('catalog, connection_fingerprint, catalog_fetched_at, catalog_error_code')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) {
      console.error('[ai/connections/models] read error:', error)
      return NextResponse.json({ error: 'Failed to load models' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Connection not found' }, { status: 404 })

    const row = data as Pick<
      ConnectionRow,
      'catalog' | 'connection_fingerprint' | 'catalog_fetched_at' | 'catalog_error_code'
    >
    const now = Date.now()
    const envelope = unpackCatalogEnvelope(row.catalog)
    const fresh = catalogIsFresh(row.catalog, row.connection_fingerprint, now)
    return NextResponse.json({
      models: envelope?.catalog.models ?? [],
      fetchedAt: row.catalog_fetched_at,
      stale: !!envelope && !fresh,
      // "never fetched" vs "fetch failed" share this code space; the
      // client shows manual entry either way.
      errorCode: row.catalog_error_code,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
