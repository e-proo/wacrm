import { supabaseAdmin } from '@/lib/ai/admin-client'
import type { RunPlane } from '@/lib/ai/runtime/multi-agent-types'

interface DefinitionRow {
  field_key: string
  visibility: 'public' | 'internal' | 'ai_only'
}

/**
 * Projection, not validation: stored revisions may legitimately contain
 * fields hidden from the current AI plane. Hidden keys are simply omitted
 * before any model can observe them.
 */
export async function projectServiceFieldsForAgent(input: {
  accountId: string
  schemaVersionId: string
  plane: RunPlane
  values: Record<string, unknown> | null | undefined
}): Promise<Record<string, unknown>> {
  const { data, error } = await supabaseAdmin()
    .from('service_field_definitions')
    .select('field_key, visibility')
    .eq('account_id', input.accountId)
    .eq('schema_version_id', input.schemaVersionId)
  if (error) throw error

  const allowed = new Set(
    ((data ?? []) as DefinitionRow[])
      .filter((d) =>
        input.plane === 'customer'
          ? d.visibility === 'public'
          : d.visibility === 'public' || d.visibility === 'ai_only',
      )
      .map((d) => d.field_key),
  )
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input.values ?? {})) {
    if (allowed.has(key)) out[key] = value
  }
  return out
}
