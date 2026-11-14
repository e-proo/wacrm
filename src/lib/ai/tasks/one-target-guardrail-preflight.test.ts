import { describe, it, expect } from 'vitest'
import { assertScopedOpenWATestPilotMode, inspectOpenWAGuardrailReservationWindow } from './one-target-guardrail-preflight'

describe('SOF-63 OpenWA safe capacity preflight', () => {
  const nowMs = Date.parse('2026-11-14T15:45:00Z')
  it('includes manual and agent reservations across 24 hours and uses rolling-window cap', () => {
    const values = [
      '2026-11-13T16:51:10Z',
      '2026-11-13T18:04:22Z',
      '2026-11-14T12:48:07Z',
    ]
    expect(inspectOpenWAGuardrailReservationWindow({ nowMs,
      hourlyCap: 1,dailyCap: 1,reservedAt:values
    })).toEqual({allowed:false,quota:'daily_cap', availableAt:'2026-11-15T12:48:07.000Z'})
  })
  it('shows hourly block separately from daily block', () => {
    expect(inspectOpenWAGuardrailReservationWindow({ nowMs, hourlyCap:1,
      dailyCap:10,reservedAt:['2026-11-14T15:35:00Z']
    })).toEqual({allowed:false,quota:'hourly_cap',availableAt:'2026-11-14T16:35:00.000Z'})
  })
  it('allows an empty window without changing any reservation', () => {
    expect(inspectOpenWAGuardrailReservationWindow({
      nowMs,hourlyCap:1,dailyCap:1,reservedAt:[]
    })).toEqual({allowed:true})
  })
  it('does not count expired reservations and rejects invalid inputs', () => {
    expect(inspectOpenWAGuardrailReservationWindow({
      nowMs,hourlyCap:1,dailyCap:1,
      reservedAt:['2026-11-13T15:44:59Z'],
    })).toEqual({allowed:true})
    expect(() => inspectOpenWAGuardrailReservationWindow({
      nowMs,hourlyCap:0,dailyCap:1,reservedAt:[]
    })).toThrow('OPENWA_PREFLIGHT_CONFIG_INVALID')
    expect(() => inspectOpenWAGuardrailReservationWindow({
      nowMs,hourlyCap:1,dailyCap:1,reservedAt:['bad']
    })).toThrow('OPENWA_PREFLIGHT_RESERVATION_TIMESTAMP_INVALID')
  })
})

describe('SOF-63 disabled OpenWA Pilot scoped own-number test acknowledgment', () => {
  const nowMs = Date.parse('2026-11-14T16:15:00Z')
  const expiredRevokedGrant = {
    active: false, expiresAt: '2026-11-14T16:00:00Z',
  }
  it('fails closed when Pilot is disabled but no independent explicit operator acknowledgment exists', () => {
    expect(() => assertScopedOpenWATestPilotMode({
      pilotEnabled: false,
      grant: expiredRevokedGrant,
      nowMs,
    })).toThrow('PILOT_OFF_REQUIRES_EXPLICIT_TEST_ACK')
    expect(() => assertScopedOpenWATestPilotMode({
      pilotEnabled: false,
      acknowledgment: 'UNSCOPED',
      grant: expiredRevokedGrant,
      nowMs,
    })).toThrow('PILOT_OFF_REQUIRES_EXPLICIT_TEST_ACK')
  })
  it('permits only the explicit TEST acknowledgment while historical signed hash and inbound remain independently required', () => {
    expect(() => assertScopedOpenWATestPilotMode({
      pilotEnabled: false,
      acknowledgment: 'TEST_OWN_NUMBER_SCOPED',
      grant: expiredRevokedGrant,
      nowMs,
    })).not.toThrow()
  })
  it('preserves current active, unexpired grant requirement when OpenWA Pilot is enabled', () => {
    expect(() => assertScopedOpenWATestPilotMode({
      pilotEnabled: true,
      acknowledgment: 'TEST_OWN_NUMBER_SCOPED',
      grant: expiredRevokedGrant,
      nowMs,
    })).toThrow('ACTIVE_AGENT_PILOT_GRANT_REQUIRED')
    expect(() => assertScopedOpenWATestPilotMode({
      pilotEnabled: true,
      acknowledgment: undefined,
      grant: { active: true, expiresAt: '2026-11-14T17:00:00Z' },
      nowMs,
    })).not.toThrow()
  })
})
