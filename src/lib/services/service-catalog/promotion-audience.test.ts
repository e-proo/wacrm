import { describe, expect, it, vi } from 'vitest'
import {
  assertTenantPromotionContacts,
  parseFrozenServicePromotionContactIds,
  resolveServicePromotionAudience,
} from './promotion-audience'
import { SERVICE_PROMOTION_AUDIENCE_RESOLVER } from './agent-task'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ACCOUNT = id(1)
const FOREIGN = id(2)
const REQUIRED = id(11)
const EXCLUDED = id(12)
const A = id(101)
const B = id(102)
const C = id(103)

type Row = { contact_id: string; tag_id: string; account_id: string }
function fakeDb(input: {
  tags?: string[]
  links?: Row[]
  contacts?: string[]
}) {
  const from = vi.fn((table: string) => {
    const eqs = new Map<string, string>()
    const ins = new Map<string, string[]>()
    const query = {
      select: (_columns: string) => query,
      eq: (column: string, value: string) => { eqs.set(column, value); return query },
      in: (column: string, values: string[]) => { ins.set(column, values); return query },
      order: (_column: string, _options?: unknown) => query,
      limit: async (_n: number) => ({
        data: table === 'tags'
          ? (input.tags ?? []).filter(v => ins.get('id')?.includes(v) &&
              eqs.get('account_id') === ACCOUNT).map(v => ({ id: v }))
          : table === 'contacts'
            ? (input.contacts ?? []).filter(v => ins.get('id')?.includes(v) &&
              eqs.get('account_id') === ACCOUNT).map(v => ({ id: v }))
            : [],
        error: null,
      }),
      range: async (first: number, last: number) => ({
        data: (input.links ?? [])
          .filter(v => table === 'contact_tags' &&
            ins.get('tag_id')?.includes(v.tag_id) &&
            eqs.get('contacts.account_id') === v.account_id &&
            eqs.get('tags.account_id') === ACCOUNT)
          .sort((a, b) => a.contact_id.localeCompare(b.contact_id) ||
            a.tag_id.localeCompare(b.tag_id))
          .slice(first, last + 1),
        error: null,
      }),
    }
    return query
  })
  return { db: { from } as never, from }
}

describe('Service Promotion frozen audience', () => {
  it('validates account-owned tag and contact joins and excludes suppressed tags', async () => {
    const { db, from } = fakeDb({
      tags: [REQUIRED, EXCLUDED],
      links: [
        { contact_id: A, tag_id: REQUIRED, account_id: ACCOUNT },
        { contact_id: B, tag_id: REQUIRED, account_id: ACCOUNT },
        { contact_id: B, tag_id: EXCLUDED, account_id: ACCOUNT },
        { contact_id: C, tag_id: REQUIRED, account_id: FOREIGN },
      ],
    })
    await expect(resolveServicePromotionAudience(db, {
      accountId: ACCOUNT, requiredTagIds: [REQUIRED],
      excludedTagIds: [EXCLUDED], maxContacts: 2,
    })).resolves.toEqual([A])
    expect(from).toHaveBeenCalledWith('tags')
    expect(from).toHaveBeenCalledWith('contact_tags')
  })

  it('denies a cross-account tag before scanning membership', async () => {
    const { db, from } = fakeDb({ tags: [REQUIRED] })
    await expect(resolveServicePromotionAudience(db, {
      accountId: ACCOUNT, requiredTagIds: [REQUIRED, EXCLUDED],
      maxContacts: 3,
    })).rejects.toThrow('SERVICE_PROMOTION_TAG_OUTSIDE_ACCOUNT')
    expect(from).not.toHaveBeenCalledWith('contact_tags')
  })

  it('fails closed instead of silently selecting the first N contacts', async () => {
    const { db } = fakeDb({ tags: [REQUIRED], links: [
      { contact_id: A, tag_id: REQUIRED, account_id: ACCOUNT },
      { contact_id: B, tag_id: REQUIRED, account_id: ACCOUNT },
    ] })
    await expect(resolveServicePromotionAudience(db, {
      accountId: ACCOUNT, requiredTagIds: [REQUIRED], maxContacts: 1,
    })).rejects.toThrow('SERVICE_PROMOTION_AUDIENCE_EXCEEDS_APPROVED_LIMIT')
  })

  it('paginates all matching tag links, never a truncated arbitrary first page', async () => {
    const links = Array.from({ length: 501 }, (_, n) => ({
      contact_id: id(1000 + n), tag_id: REQUIRED, account_id: ACCOUNT,
    }))
    const { db } = fakeDb({ tags: [REQUIRED], links })
    await expect(resolveServicePromotionAudience(db, {
      accountId: ACCOUNT, requiredTagIds: [REQUIRED], maxContacts: 100,
    })).rejects.toThrow('SERVICE_PROMOTION_AUDIENCE_EXCEEDS_APPROVED_LIMIT')
  })

  it('keeps an approved frozen cohort even when tags change; checks tenant ownership', async () => {
    const { db, from } = fakeDb({ contacts: [A, B] })
    const context = {
      accountId: ACCOUNT, taskId: id(50), taskType: 'services.promotion',
      taskTypeVersion: 1, taskContext: {},
      targetPolicy: {
        frozenContactIds: [B, A],
        requiredTagIds: [REQUIRED],
      }, maxCandidates: 100,
    }
    const recipients = await SERVICE_PROMOTION_AUDIENCE_RESOLVER.resolve(db, context)
    expect(recipients.map(x => x.contactId)).toEqual([B, A])
    expect(from).not.toHaveBeenCalledWith('contact_tags')
    await expect(assertTenantPromotionContacts(db, ACCOUNT, [A, C]))
      .rejects.toThrow('SERVICE_PROMOTION_CONTACT_OUTSIDE_ACCOUNT')
  })

  it('fails closed pre-snapshot promotion tasks instead of expanding a changed tag audience', async () => {
    const { db, from } = fakeDb({ tags: [REQUIRED], links: [
      { contact_id: C, tag_id: REQUIRED, account_id: ACCOUNT },
    ] })
    await expect(SERVICE_PROMOTION_AUDIENCE_RESOLVER.resolve(db, {
      accountId: ACCOUNT, taskId: id(60), taskType: 'services.promotion',
      taskTypeVersion: 1, taskContext: {},
      targetPolicy: { requiredTagIds: [REQUIRED] }, maxCandidates: 100,
    })).rejects.toThrow('SERVICE_PROMOTION_LEGACY_AUDIENCE_REQUIRES_REAPPROVAL')
    expect(from).not.toHaveBeenCalled()
  })

  it('rejects malformed, duplicated and excessive frozen identities', () => {
    expect(() => parseFrozenServicePromotionContactIds([A, A]))
      .toThrow('SERVICE_PROMOTION_FROZEN_AUDIENCE_INVALID')
    expect(() => parseFrozenServicePromotionContactIds([FOREIGN, 'fake']))
      .toThrow('SERVICE_PROMOTION_FROZEN_AUDIENCE_INVALID')
    expect(() => parseFrozenServicePromotionContactIds(
      Array.from({ length: 101 }, (_, n) => id(2000 + n)),
    )).toThrow('SERVICE_PROMOTION_FROZEN_AUDIENCE_INVALID')
  })
})
