import type { SupabaseClient } from '@supabase/supabase-js'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Exact, bounded promotion membership; never derive additional recipients after task approval. */
export const MAX_SERVICE_PROMOTION_RECIPIENTS = 100
const TAG_LINK_PAGE_SIZE = 500
const MAX_SCANNED_TAG_LINKS = 20_000

export function normalizeServicePromotionTagIds(raw: unknown, required: boolean): string[] {
  if (!Array.isArray(raw) || raw.length > 100 ||
      (required && raw.length === 0) ||
      raw.some(value => typeof value !== 'string' || !UUID_RE.test(value))) {
    throw new Error('SERVICE_PROMOTION_SEGMENT_TAGS_INVALID')
  }
  return [...new Set(raw as string[])].sort()
}

export function parseFrozenServicePromotionContactIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_SERVICE_PROMOTION_RECIPIENTS ||
      raw.some(value => typeof value !== 'string' || !UUID_RE.test(value)) ||
      new Set(raw).size !== raw.length) {
    throw new Error('SERVICE_PROMOTION_FROZEN_AUDIENCE_INVALID')
  }
  return [...(raw as string[])]
}

export async function assertTenantPromotionContacts(
  db: SupabaseClient,
  accountId: string,
  contactIds: readonly string[],
): Promise<void> {
  if (contactIds.length === 0) return
  const { data, error } = await db.from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .in('id', [...contactIds])
    .limit(contactIds.length)
  if (error) throw error
  const valid = new Set((data ?? []).map(row => String(row.id)))
  if (contactIds.some(id => !valid.has(id))) {
    throw new Error('SERVICE_PROMOTION_CONTACT_OUTSIDE_ACCOUNT')
  }
}

/**
 * This is the bounded, read-only stage before an approved Task is created.
 * contact_tags has NO account_id, therefore *both* joined entities must be
 * tenant-filtered; service_role alone is not a tenant boundary.
 * Returns all matching contacts or fails closed: a LIMIT may not silently
 * create a different campaign than the operator authorized.
 */
export async function resolveServicePromotionAudience(
  db: SupabaseClient,
  input: {
    accountId: string
    requiredTagIds: readonly string[]
    excludedTagIds?: readonly string[]
    maxContacts: number
  },
): Promise<string[]> {
  const required = normalizeServicePromotionTagIds(input.requiredTagIds, true)
  const excluded = normalizeServicePromotionTagIds(input.excludedTagIds ?? [], false)
  if (required.some(id => excluded.includes(id))) {
    throw new Error('SERVICE_PROMOTION_SEGMENT_TAG_CONFLICT')
  }
  if (!Number.isInteger(input.maxContacts) || input.maxContacts < 1 ||
      input.maxContacts > MAX_SERVICE_PROMOTION_RECIPIENTS) {
    throw new Error('SERVICE_PROMOTION_AUDIENCE_LIMIT_INVALID')
  }

  const allTags = [...new Set([...required, ...excluded])]
  const { data: tags, error: tagsError } = await db.from('tags')
    .select('id')
    .eq('account_id', input.accountId)
    .in('id', allTags)
    .limit(allTags.length)
  if (tagsError) throw tagsError
  const owned = new Set((tags ?? []).map(tag => String(tag.id)))
  if (allTags.some(id => !owned.has(id))) {
    throw new Error('SERVICE_PROMOTION_TAG_OUTSIDE_ACCOUNT')
  }

  const matches = new Map<string, Set<string>>()
  let offset = 0
  for (;;) {
    const { data, error } = await db.from('contact_tags')
      .select('contact_id, tag_id, contacts!inner(account_id), tags!inner(account_id)')
      .in('tag_id', allTags)
      .eq('contacts.account_id', input.accountId)
      .eq('tags.account_id', input.accountId)
      .order('contact_id', { ascending: true })
      .order('tag_id', { ascending: true })
      .range(offset, offset + TAG_LINK_PAGE_SIZE - 1)
    if (error) throw error
    const rows = data ?? []
    if (offset + rows.length > MAX_SCANNED_TAG_LINKS) {
      throw new Error('SERVICE_PROMOTION_AUDIENCE_TOO_LARGE')
    }
    for (const row of rows) {
      const contactId = String(row.contact_id ?? '')
      const tagId = String(row.tag_id ?? '')
      if (!UUID_RE.test(contactId) || !allTags.includes(tagId)) {
        throw new Error('SERVICE_PROMOTION_AUDIENCE_ROW_INVALID')
      }
      const set = matches.get(contactId) ?? new Set<string>()
      set.add(tagId)
      matches.set(contactId, set)
    }
    if (rows.length < TAG_LINK_PAGE_SIZE) break
    offset += rows.length
    // Request one more page even at exactly MAX; this detects truncation.
    if (offset >= MAX_SCANNED_TAG_LINKS) {
      throw new Error('SERVICE_PROMOTION_AUDIENCE_TOO_LARGE')
    }
  }

  const contactIds = [...matches.entries()]
    .filter(([, tags]) => required.every(id => tags.has(id)) &&
      excluded.every(id => !tags.has(id)))
    .map(([contactId]) => contactId)
    .sort()
  if (contactIds.length > input.maxContacts) {
    throw new Error('SERVICE_PROMOTION_AUDIENCE_EXCEEDS_APPROVED_LIMIT')
  }
  return contactIds
}
