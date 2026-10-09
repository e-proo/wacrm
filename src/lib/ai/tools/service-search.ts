import { supabaseAdmin } from '@/lib/ai/admin-client'
import { projectServiceFieldsForAgent } from './service-field-visibility'
import type {
  ServicesGetArgs,
  ServicesGetRow,
  ServicesSearchArgs,
  ServicesSearchRow,
  ToolContext,
  ToolResult,
} from './executors'

interface SearchDbRow {
  id: string
  name: string
  code: string
  category_id: string
  status: string
  created_at: string
}

function toSearchRow(row: SearchDbRow): ServicesSearchRow {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    category_id: row.category_id,
    // public_description belongs to service_revisions, not services.
    // Search intentionally stays on the identity table so even the seeded
    // coverage service (which may have no revision) is discoverable.
    public_description: null,
    status: row.status,
  }
}

function mergeRows(groups: Array<SearchDbRow[]>, limit: number): ServicesSearchRow[] {
  const byId = new Map<string, SearchDbRow>()
  for (const group of groups) {
    for (const row of group) {
      const current = byId.get(row.id)
      if (!current || row.created_at > current.created_at) byId.set(row.id, row)
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map(toSearchRow)
}

function searchTerms(value: string): string[] {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .replace(/[،,;؛|/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
  if (!normalized) return []

  // Try the full phrase first, then individual meaningful words. This lets a
  // request such as "تغطية شبكات" still discover the seeded service named
  // "التغطية" without teaching the generic service search coverage semantics.
  const parts = normalized.split(' ').filter((part) => part.length >= 2)
  return [...new Set([normalized, ...parts])].slice(0, 6)
}

export const serviceSearchTermsForTest = searchTerms

/**
 * PostgREST-safe service search for model-provided free text.
 *
 * `public_description` lives on service_revisions, not services. Search only
 * needs identity fields and therefore deliberately avoids a revision embed;
 * this keeps always-present seeded services discoverable even before they have
 * a published revision. Full details are loaded by services.get.
 *
 * Do not build an `.or(name.ilike...,code.ilike...)` expression from model
 * text: commas and parentheses are PostgREST filter grammar delimiters. Each
 * term is sent through a normal `.ilike()` value parameter instead.
 */
export async function executeServicesSearchSafe(
  ctx: ToolContext,
  args: ServicesSearchArgs,
): Promise<ToolResult<ServicesSearchRow[]>> {
  const limit = Math.min(args.limit ?? 10, 50)
  const select = 'id, name, code, category_id, status, created_at'

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
    const terms = args.query ? searchTerms(args.query) : []
    if (terms.length === 0) {
      const { data, error } = await baseQuery()
      if (error) throw error
      return {
        ok: true,
        data: mergeRows([(data ?? []) as unknown as SearchDbRow[]], limit),
        safe_to_show: true,
      }
    }

    const queries = terms.flatMap((term) => {
      const pattern = `%${term}%`
      return [baseQuery().ilike('name', pattern), baseQuery().ilike('code', pattern)]
    })
    const results = await Promise.all(queries)
    const failed = results.find((result) => result.error)
    if (failed?.error) throw failed.error

    return {
      ok: true,
      data: mergeRows(
        results.map((result) => (result.data ?? []) as unknown as SearchDbRow[]),
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

/**
 * Schema-aligned services.get. The service identity row does not carry the
 * public description or field values; those belong to its current revision.
 * A service without a current revision is still a valid identity and returns
 * empty revision details instead of a database-column error.
 */
export async function executeServicesGetSafe(
  ctx: ToolContext,
  args: ServicesGetArgs,
): Promise<ToolResult<ServicesGetRow>> {
  if (!args.id_or_code?.trim()) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'id_or_code is required.',
    }
  }

  try {
    const isUuid = /^[0-9a-f]{8}-/i.test(args.id_or_code)
    let query = supabaseAdmin()
      .from('services')
      .select('id, name, code, category_id, status, current_revision_id')
      .eq('account_id', ctx.accountId)
      .limit(1)
    query = isUuid
      ? query.eq('id', args.id_or_code)
      : query.eq('code', args.id_or_code)

    const { data: service, error: serviceError } = await query.maybeSingle()
    if (serviceError) throw serviceError
    if (!service) {
      return {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'NOT_FOUND',
        message: 'No service matched.',
      }
    }

    const svc = service as {
      id: string
      name: string
      code: string
      category_id: string
      status: string
      current_revision_id: string | null
    }

    if (!svc.current_revision_id) {
      return {
        ok: true,
        data: {
          id: svc.id,
          name: svc.name,
          code: svc.code,
          category_id: svc.category_id,
          status: svc.status,
          public_description: null,
          field_values: {},
          pricing_quote: null,
        },
        safe_to_show: true,
      }
    }

    const { data: revision, error: revisionError } = await supabaseAdmin()
      .from('service_revisions')
      .select(
        'public_description, field_values, category_schema_version_id, service_pricing_rules(id, kind, fee_currency, input_currency, formula_config)',
      )
      .eq('account_id', ctx.accountId)
      .eq('id', svc.current_revision_id)
      .maybeSingle()
    if (revisionError) throw revisionError

    const rev = revision as {
      public_description: string | null
      field_values: Record<string, unknown> | null
      category_schema_version_id: string
      service_pricing_rules: unknown
    } | null

    const visibleFieldValues = rev
      ? await projectServiceFieldsForAgent({
          accountId: ctx.accountId,
          schemaVersionId: rev.category_schema_version_id,
          plane: ctx.plane,
          values: rev.field_values,
        })
      : {}

    return {
      ok: true,
      data: {
        id: svc.id,
        name: svc.name,
        code: svc.code,
        category_id: svc.category_id,
        status: svc.status,
        public_description: rev?.public_description ?? null,
        field_values: visibleFieldValues,
        pricing_quote: rev?.service_pricing_rules ?? null,
      },
      safe_to_show: true,
    }
  } catch (err) {
    console.error('[tool] services.get failed:', err, { id_or_code: args.id_or_code })
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'READ_FAILED',
      message: 'Could not read the service.',
    }
  }
}
