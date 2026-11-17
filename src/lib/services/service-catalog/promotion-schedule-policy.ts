/** Freeze only the operator-approved campaign *identity*. No phone numbers,
 * credentials or transport tokens are placed into scheduler policies.
 * The campaign is re-inspected against the live account before every new Task.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEX64 = /^[a-f0-9]{64}$/
export const PROMOTION_SCHEDULE_APPROVAL_MAX_AGE_MS = 30 * 86400_000

export type PromotionScheduledReview = {
  schemaVersion: 1
  serviceId: string
  agentId: string
  approvedRevisionId: string
  approvedBy: string
  connectionId: string
  provider: 'meta_cloud' | 'openwa'
  fingerprint: string
  reviewedAt: string
  approvedAt: string
  frozenContactIds: string[]
  consentAcknowledged: true
  approvalAcknowledged: true
  recurringAcknowledged: boolean
}

export function readFrozenPromotionSchedule(
  config: Readonly<Record<string, unknown>>,
  input: { serviceId: string; agentId: string; approvedRevisionId: string | null;
    createdBy: string | null },
): PromotionScheduledReview {
  const value = config.promotionReview
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('SERVICE_PROMOTION_SCHEDULE_REVIEW_REQUIRED')
  const r = value as Record<string, unknown>
  if (r.schemaVersion !== 1 || r.serviceId !== input.serviceId ||
    r.agentId !== input.agentId || r.approvedRevisionId !== input.approvedRevisionId ||
    r.approvedBy !== input.createdBy ||
    !UUID.test(String(r.connectionId ?? '')) ||
    (r.provider !== 'meta_cloud' && r.provider !== 'openwa') ||
    !HEX64.test(String(r.fingerprint ?? '')) ||
    typeof r.reviewedAt !== 'string' || typeof r.approvedAt !== 'string' ||
    r.consentAcknowledged !== true || r.approvalAcknowledged !== true ||
    typeof r.recurringAcknowledged !== 'boolean' ||
    !Array.isArray(r.frozenContactIds) || r.frozenContactIds.length < 1 ||
    r.frozenContactIds.length > 100 ||
    !r.frozenContactIds.every(id => typeof id === 'string' && UUID.test(id)) ||
    new Set(r.frozenContactIds).size !== r.frozenContactIds.length) {
    throw new Error('SERVICE_PROMOTION_SCHEDULE_REVIEW_INVALID')
  }
  const when = Date.parse(r.approvedAt)
  const previewTime = Date.parse(r.reviewedAt)
  if (!Number.isFinite(when) || !Number.isFinite(previewTime) ||
    when < previewTime || when > Date.now() + 30_000 ||
    Date.now() - when > PROMOTION_SCHEDULE_APPROVAL_MAX_AGE_MS) {
    throw new Error('SERVICE_PROMOTION_SCHEDULE_APPROVAL_EXPIRED')
  }
  return r as PromotionScheduledReview
}

export function samePromotionAudience(expected: readonly string[], actual: readonly string[]): boolean {
  return expected.length === actual.length &&
    [...expected].sort().every((id, index) => id === [...actual].sort()[index])
}
