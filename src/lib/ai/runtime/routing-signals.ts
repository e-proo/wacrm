import type { SupabaseClient } from '@supabase/supabase-js'

export interface RuntimeRoutingSignals {
  inboxId: string | null
  tags: string[]
  language: string | null
}

/**
 * Load deterministic routing signals from data that already exists in wacrm.
 * Tag conditions authored in the current UI are free-text tag names, so the
 * runtime resolves contact_tags -> tags.name rather than comparing UUIDs.
 */
export async function loadRuntimeRoutingSignals(
  db: SupabaseClient,
  input: {
    accountId: string
    contactId: string
    inboxId: string | null
    text: string | null | undefined
  },
): Promise<RuntimeRoutingSignals> {
  const { data, error } = await db
    .from('contact_tags')
    .select('tags!inner(name, account_id)')
    .eq('contact_id', input.contactId)
    .eq('tags.account_id', input.accountId)

  if (error) throw error

  const names = new Set<string>()
  for (const row of data ?? []) {
    const raw = (row as { tags?: { name?: unknown } | Array<{ name?: unknown }> }).tags
    const tag = Array.isArray(raw) ? raw[0] : raw
    if (typeof tag?.name !== 'string') continue
    const normalized = normalizeRouteTag(tag.name)
    if (normalized) names.add(normalized)
  }

  return {
    inboxId: input.inboxId,
    tags: [...names],
    language: detectRoutingLanguage(input.text ?? ''),
  }
}

export function normalizeRouteTag(value: string): string {
  return value.trim().toLocaleLowerCase()
}

/**
 * Conservative language signal for the two languages the current WhatsApp
 * product is able to infer without an external classifier. Mixed/ambiguous
 * text returns null, so a language route does not accidentally match.
 */
export function detectRoutingLanguage(text: string): 'ar' | 'en' | null {
  const letters = [...text].filter((ch) => /\p{L}/u.test(ch))
  if (letters.length < 2) return null

  let arabic = 0
  let latin = 0
  for (const ch of letters) {
    if (/\p{Script=Arabic}/u.test(ch)) arabic += 1
    else if (/\p{Script=Latin}/u.test(ch)) latin += 1
  }

  const meaningful = arabic + latin
  if (meaningful === 0) return null
  if (arabic / meaningful >= 0.8) return 'ar'
  if (latin / meaningful >= 0.8) return 'en'
  return null
}
