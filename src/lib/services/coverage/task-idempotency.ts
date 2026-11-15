/**
 * Durable idempotency is per deliberate manual submission, not forever per
 * Coverage request. Retrying the SAME submission reuses its identifier,
 * while starting a new Task after a terminal one uses another UUID.
 * Scheduled/business-event triggers retain their deterministic source key.
 */
export interface CoverageTaskIdentity {
  coverageRequestId: string
  agentId: string
  revisionId: string
  sourceKey?: string | null
  manualSubmissionId?: string | null
}
export function coverageSourcingIdempotencyKey(input: CoverageTaskIdentity): string {
  const base = 'coverage:sourcing:request:' + input.coverageRequestId +
    ':agent:' + input.agentId + ':revision:' + input.revisionId
  if (input.sourceKey) return base + ':source:' + input.sourceKey
  if (input.manualSubmissionId) return base + ':manual:' + input.manualSubmissionId
  // Preserve legacy/trigger callers until they migrate to submission IDs.
  return base
}
export function coverageSourcingCorrelationId(input: CoverageTaskIdentity): string {
  const base = 'coverage:sourcing:' + input.coverageRequestId + ':' + input.revisionId
  if (input.sourceKey) return base + ':source:' + input.sourceKey
  if (input.manualSubmissionId) return base + ':manual:' + input.manualSubmissionId
  return base
}
