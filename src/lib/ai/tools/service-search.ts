import { supabaseAdmin } from '@/lib/ai/admin-client'
import type {
  ServicesSearchArgs,
  ServicesSearchRow,
  ToolContext,
  ToolResult,
} from './executors'

interface SearchRow extends ServicesSearchRow {
  created_at: string
}

function mergeRows(groups: Array<SearchRow[]>, limit: number): ServicesSearchRow[] {
  const byId = new Map<string, SearchRow>()
  for (const group of groups) {
    for (const row of group) {
      const current = byId.get(row.id)
      if (!current || row.created_at > current.created_at) byId.set(row.id, row)
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map(({ created_at: _createdAt, ...row }) => row)
}

/**
 * PostgREST-safe service search for model-provided free text.
 *
 * Do not build an `.or(name.ilike...,code.ilike...)` expression from model
 * text: commas and parentheses are PostgREST filter grammar delimiters and can
 * turn an ordinary search into SEARCH_FAILED. Independent `.ilike()` queries
 * keep the value in a normal encoded query parameter and are deterministic.
 */
export async function executeServicesSearchSafe(
  ctx: ToolContext,
  args: ServicesSearchArgs,
): Promise<ToolResult<ServicesSearchRow[]>> {
  const limit = Math.min(args.limit ?? 10, 50)
  const select = 'id, name, code, category_id, public_description, status, created_at'

  const baseQuery = () => {
    let query = supabaseAdmin()
      .from('services')
      .select(select)
      .eq('account_id', ctx.accountId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (args.category_id) query = query.eq('category_id', args.category_id)
    return query
  }

  try {
    if (!args.query?.trim()) {
      const { data, error } = await baseQuery()
      if (error) throw error
      return {
        ok: true,
        data: mergeRows([(data ?? []) as unknown as SearchRow[]], limit),
        safe_to_show: true,
      }
    }

    const term = `%${args.query.trim()}%`
    const [byName, byCode] = await Promise.all([
      baseQuery().ilike('name', term),
      baseQuery().ilike('code', term),
    ])
    if (byName.error) throw byName.error
    if (byCode.error) throw byCode.error

    return {
      ok: true,
      data: mergeRows(
        [
          (byName.data ?? []) as unknown as SearchRow[],
          (byCode.data ?? []) as unknown as SearchRow[],
        ],
        limit,
      ),
      safe_to_show: true,
    }
  } catch (err) {
    console.error('[tool] services.search failed:', err, {
      query: args.query ?? null,
      category_id: args.category_id ?? null,
    })
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'SEARCH_FAILED',
      message: 'Could not run the search.',
    }
  }
}
