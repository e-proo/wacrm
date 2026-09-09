// Server-only by convention.
import { supabaseAdmin } from '@/lib/ai/admin-client'
import type { FieldDefinitionInput } from '@/lib/services/catalog/field-schema'

// ============================================================
// Service request matcher.
//
// The agent's ONLY honest answer when a customer's request does
// not fit an equipped service schema is a THREE-WAY verdict:
//
//   exact   — every required field present, nothing unknown.
//   partial — the service fits but fields are missing/extra;
//             the agent asks the customer for the missing ones.
//   none    — no equipped service can express the request; the
//             agent records a general intent and escalates.
//
// The matcher NEVER invents fields, prices, or promises. Extra
// keys the customer mentioned (not in the schema) surface as
// `unknown_fields` for the admin to consider when equipping a
// richer schema later.
// ============================================================

export type MatchClassification = 'exact' | 'partial' | 'none'

export interface MatchedCandidate {
  service_id: string
  name: string
  code: string
  category_id: string
  classification: MatchClassification
  missing_fields: string[]
  unknown_fields: string[]
}

export interface MatchResult {
  match: MatchClassification
  candidates: MatchedCandidate[]
}

/** Per-candidate classification, over the declared field list. */
export function classifyCandidate(
  provided: Record<string, unknown>,
  fieldDefs: Array<{ field_key: string; required: boolean }>,
): { classification: MatchClassification; missing_fields: string[]; unknown_fields: string[] } {
  const missing: string[] = []
  const unknown: string[] = []
  const declared = new Set(fieldDefs.map((f) => f.field_key))

  for (const def of fieldDefs) {
    if (!def.required) continue
    const value = provided[def.field_key]
    if (value === undefined || value === null || value === '') {
      missing.push(def.field_key)
    }
  }
  for (const key of Object.keys(provided)) {
    if (!declared.has(key)) unknown.push(key)
    // Provided-but-null counts as missing, not unknown.
    if (provided[key] === null || provided[key] === '') {
      if (!unknown.includes(key)) {
        // null on an OPTIONAL field is fine; leave it out.
        const idx = unknown.indexOf(key)
        if (idx >= 0) unknown.splice(idx, 1)
      }
    }
  }

  let classification: MatchClassification
  if (missing.length === 0 && unknown.length === 0) {
    classification = 'exact'
  } else if (missing.length <= 1) {
    // A single missing required field is a quick clarification —
    // the agent asks the customer instead of escalating.
    classification = 'partial'
  } else {
    classification = 'none'
  }
  return { classification, missing_fields: missing, unknown_fields: unknown }
}

/** Collapse per-candidate classifications into an overall verdict. */
export function overallMatch(candidates: MatchedCandidate[]): MatchClassification {
  if (candidates.some((c) => c.classification === 'exact')) return 'exact'
  if (candidates.some((c) => c.classification === 'partial')) return 'partial'
  return 'none'
}

interface FieldDefRow {
  schema_version_id: string
  field_key: string
  required: boolean
}

export interface MatchRequestInput {
  accountId: string
  serviceHint?: string
  attributes: Record<string, unknown>
  limit?: number
}

/**
 * Live matcher. Reads equipped services + their published schema
 * field definitions and classifies the request. Account-scoped.
 */
export async function matchServiceRequest(
  input: MatchRequestInput,
): Promise<MatchResult> {
  if (!input.attributes || typeof input.attributes !== 'object') {
    throw new Error('attributes object is required')
  }
  const db = supabaseAdmin()
  const limit = Math.min(input.limit ?? 10, 50)

  let q = db
    .from('services')
    .select(
      'id, name, code, category_id, status, service_categories(name), service_revisions!services_current_revision_fk(category_schema_version_id)',
    )
    .eq('account_id', input.accountId)
    .eq('status', 'active')
    .limit(limit * 3)
  if (input.serviceHint?.trim()) {
    const term = `%${input.serviceHint.trim()}%`
    q = q.or(`name.ilike.${term},code.ilike.${term}`)
  }
  const { data: services, error } = await q
  if (error) throw error

  const rows = (services ?? []) as Array<{
    id: string
    name: string
    code: string
    category_id: string
    service_categories: { name: string } | { name: string }[] | null
    service_revisions: { category_schema_version_id: string } | { category_schema_version_id: string }[] | null
  }>

  const candidates: Array<{
    row: { id: string; name: string; code: string; category_id: string }
    schemaVersionId: string | null
  }> = []
  const schemaVersionIds = new Set<string>()
  for (const row of rows) {
    const rev = Array.isArray(row.service_revisions)
      ? row.service_revisions[0]
      : row.service_revisions
    const schemaVersionId = rev?.category_schema_version_id ?? null
    if (schemaVersionId) schemaVersionIds.add(schemaVersionId)
    candidates.push({
      row: { id: row.id, name: row.name, code: row.code, category_id: row.category_id },
      schemaVersionId,
    })
  }

  // Field definitions for all involved schema versions, one read.
  const defsByVersion = new Map<string, Array<{ field_key: string; required: boolean }>>()
  if (schemaVersionIds.size > 0) {
    const { data: defs, error: defsErr } = await db
      .from('service_field_definitions')
      .select('schema_version_id, field_key, required')
      .in('schema_version_id', [...schemaVersionIds])
    if (defsErr) throw defsErr
    for (const def of defs ?? []) {
      const r = def as { schema_version_id: string; field_key: string; required: boolean }
      const list = defsByVersion.get(r.schema_version_id) ?? []
      list.push({ field_key: r.field_key, required: r.required })
      defsByVersion.set(r.schema_version_id, list)
    }
  }

  const scored: MatchedCandidate[] = candidates.map((candidate) => {
    const defs = candidate.schemaVersionId
      ? (defsByVersion.get(candidate.schemaVersionId) ?? [])
      : []
    const verdict = classifyCandidate(input.attributes, defs)
    return {
      service_id: candidate.row.id,
      name: candidate.row.name,
      code: candidate.row.code,
      category_id: candidate.row.category_id,
      classification: verdict.classification,
      missing_fields: verdict.missing_fields,
      unknown_fields: verdict.unknown_fields,
    }
  })

  const order: Record<MatchClassification, number> = { exact: 0, partial: 1, none: 2 }
  scored.sort((a, b) => order[a.classification] - order[b.classification])
  const top = scored.slice(0, limit)
  return { match: overallMatch(top), candidates: top }
}
