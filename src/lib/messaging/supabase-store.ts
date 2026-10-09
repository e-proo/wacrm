import type { SupabaseClient } from '@supabase/supabase-js'
import type { PublishedTemplateOverride, TemplateOverrideStore } from './types'

interface PublicationRow {
  revision_id: string
}

interface RevisionRow {
  id: string
  template_key: string
  audience: PublishedTemplateOverride['audience']
  channel: PublishedTemplateOverride['channel']
  locale: string
  version: number
  body: string
  required_variables: string[] | null
  optional_variables: string[] | null
  secret_variables: string[] | null
  max_length: number | null
}

export function createSupabaseTemplateOverrideStore(db: SupabaseClient): TemplateOverrideStore {
  return {
    async getPublishedTemplate(input) {
      const { data: publication, error: publicationError } = await db
        .from('message_template_publications')
        .select('revision_id')
        .eq('account_id', input.accountId)
        .eq('template_key', input.key)
        .eq('audience', input.audience)
        .eq('channel', input.channel)
        .eq('locale', input.locale)
        .maybeSingle()

      if (publicationError) throw publicationError
      if (!publication) return null

      const { data: revision, error: revisionError } = await db
        .from('message_template_revisions')
        .select(
          'id, template_key, audience, channel, locale, version, body, required_variables, optional_variables, secret_variables, max_length',
        )
        .eq('account_id', input.accountId)
        .eq('id', (publication as PublicationRow).revision_id)
        .maybeSingle()

      if (revisionError) throw revisionError
      if (!revision) return null

      const row = revision as RevisionRow
      return {
        revisionId: row.id,
        version: row.version,
        key: row.template_key,
        audience: row.audience,
        channel: row.channel,
        locale: row.locale,
        body: row.body,
        requiredVariables: row.required_variables ?? [],
        optionalVariables: row.optional_variables ?? [],
        secretVariables: row.secret_variables ?? [],
        ...(row.max_length ? { maxLength: row.max_length } : {}),
      }
    },
  }
}
