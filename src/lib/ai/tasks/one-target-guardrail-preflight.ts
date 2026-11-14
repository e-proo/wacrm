/**
 * Read-only operator preflight. DB reserve_openwa_guardrail_send stays the
 * authoritative, serializing capacity gate. We merely avoid claiming a
 * one-attempt Task when capacity is obviously exhausted.
 */
export function inspectOpenWAGuardrailReservationWindow(input: {
  nowMs: number
  hourlyCap: number
  dailyCap: number
  reservedAt: readonly string[]
}): { allowed: true } | { allowed: false; quota: 'hourly_cap' | 'daily_cap'; availableAt: string } {
  const { nowMs, hourlyCap, dailyCap } = input
  if (!Number.isFinite(nowMs) || !Number.isInteger(hourlyCap) ||
      !Number.isInteger(dailyCap) || hourlyCap < 1 || dailyCap < 1) {
    throw new Error('OPENWA_PREFLIGHT_CONFIG_INVALID')
  }
  const dates = input.reservedAt.map(x => Date.parse(x))
  if (dates.some(x => !Number.isFinite(x) || x > nowMs)) {
    throw new Error('OPENWA_PREFLIGHT_RESERVATION_TIMESTAMP_INVALID')
  }
  const day = dates.filter(x => x >= nowMs - 86_400_000).sort((a,b) => a-b)
  const hour = day.filter(x => x >= nowMs - 3_600_000)

  if (hour.length >= hourlyCap) {
    const decisive = hour[hour.length-hourlyCap]
    return {
      allowed: false,
      quota: 'hourly_cap',
      availableAt: new Date(decisive + 3_600_000).toISOString(),
    }
  }
  if (day.length >= dailyCap) {
    const decisive = day[day.length-dailyCap]
    return {
      allowed: false,
      quota: 'daily_cap',
      availableAt: new Date(decisive + 86_400_000).toISOString(),
    }
  }
  return { allowed: true }
}

/**
 * Explicit opt-in for a named operator-owned TEST contact when OpenWA Pilot
 * admission is disabled for the connection. This NEVER authorizes a new
 * contact: the caller still verifies an exact frozen CRM contact, historical
 * signed recipient hash and a fresh inbound from that same OpenWA session.
 */
export function assertScopedOpenWATestPilotMode(input: {
  pilotEnabled: boolean
  acknowledgment?: string
  grant: { active: boolean; expiresAt: string | null }
  nowMs: number
}): void {
  if (!input.pilotEnabled) {
    if (input.acknowledgment !== 'TEST_OWN_NUMBER_SCOPED') {
      throw new Error('PILOT_OFF_REQUIRES_EXPLICIT_TEST_ACK')
    }
    return
  }
  if (input.grant.active !== true ||
      typeof input.grant.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(input.grant.expiresAt)) ||
      Date.parse(input.grant.expiresAt) <= input.nowMs) {
    throw new Error('ACTIVE_AGENT_PILOT_GRANT_REQUIRED')
  }
}
