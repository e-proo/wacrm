import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getApprovedOpenWATerms, openWAPolicyTextDigest } from './approved-policy-catalog'

describe('W07-05 approved policy disclosure safety', () => {
  it('has no implicit Product/Legal publication or draft-as-approved fallback', () => {
    expect(getApprovedOpenWATerms('ow14-w07-draft-2026-11-20-v1', 'a'.repeat(64))).toBeNull()
    expect(getApprovedOpenWATerms('openwa-approved-policy-v1', 'a'.repeat(64))).toBeNull()
    expect(getApprovedOpenWATerms(null, null)).toBeNull()
    expect(getApprovedOpenWATerms('version', 'not-a-digest')).toBeNull()
  })
  it('derives a deterministic bilingual content-bound SHA-256 and changes on any edit', () => {
    const ar = 'رسالة موافقة معتمدة'
    const en = 'Reviewed policy text'
    const expected = createHash('sha256').update('wacrm:openwa-operational-policy:v1\n')
      .update(ar).update('\n---\n').update(en).digest('hex')
    expect(openWAPolicyTextDigest({ ar, en })).toBe(expected)
    expect(openWAPolicyTextDigest({ ar, en })).toHaveLength(64)
    expect(openWAPolicyTextDigest({ ar: ar + '!', en })).not.toBe(expected)
    expect(openWAPolicyTextDigest({ ar, en: en + '.' })).not.toBe(expected)
  })
})
