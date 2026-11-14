import { describe, it, expect } from 'vitest'
import { inspectOpenWAGuardrailReservationWindow } from './one-target-guardrail-preflight'

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
