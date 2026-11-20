import { createHash } from 'node:crypto'

/**
 * W07-05 Product/Legal-reviewed bilingual disclosure registry.
 *
 * IMPORTANT: There are intentionally NO published policies at this stage.
 * Every future publication requires a separately approved code revision
 * containing the complete AR and EN terms, a legal approval reference and an
 * additive SQL publication of the matching SHA-256 digest/version.
 * The draft preview NEVER appears here and can never be accepted.
 */
export interface ApprovedOpenWATerms {
  version: string
  approvalRef: string
  ar: string
  en: string
}

const PUBLISHED_OPENWA_TERMS: readonly ApprovedOpenWATerms[] = []

export function openWAPolicyTextDigest(terms: Pick<ApprovedOpenWATerms, 'ar' | 'en'>): string {
  return createHash('sha256')
    .update('wacrm:openwa-operational-policy:v1\n')
    .update(terms.ar)
    .update('\n---\n')
    .update(terms.en)
    .digest('hex')
}

/**
 * This returns null if content is missing, malformed, edited or mismatched to
 * the DB-approved digest. No browser-facing action may substitute draft copy.
 */
export function getApprovedOpenWATerms(
  version: string | null | undefined,
  digest: string | null | undefined,
): ApprovedOpenWATerms | null {
  if (!version || !digest || !/^[a-f0-9]{64}$/.test(digest)) return null
  const item = PUBLISHED_OPENWA_TERMS.find(entry => entry.version === version)
  if (!item || !item.approvalRef.trim() || !item.ar.trim() || !item.en.trim()) return null
  if (openWAPolicyTextDigest(item) !== digest) return null
  return item
}
