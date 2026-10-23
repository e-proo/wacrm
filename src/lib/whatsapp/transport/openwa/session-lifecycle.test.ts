import { describe, expect, it } from 'vitest'

import { canApplyOpenWAStateTransition, normalizeOpenWAConnectionState } from './session-lifecycle'

describe('OpenWA session lifecycle', () => {
  it('normalizes provider-specific status aliases', () => {
    expect(normalizeOpenWAConnectionState('qr_ready')).toBe('waiting_qr')
    expect(normalizeOpenWAConnectionState('authenticated')).toBe('connected')
    expect(normalizeOpenWAConnectionState('online')).toBe('ready')
    expect(normalizeOpenWAConnectionState('banned')).toBe('restricted')
    expect(normalizeOpenWAConnectionState('unknown-provider-state')).toBe('failed')
  })

  it('prevents stale lifecycle updates from reviving terminal states', () => {
    expect(canApplyOpenWAStateTransition('restricted', 'ready')).toBe(false)
    expect(canApplyOpenWAStateTransition('logged_out', 'reconnecting')).toBe(false)
    expect(canApplyOpenWAStateTransition('ready', 'reconnecting')).toBe(true)
    expect(canApplyOpenWAStateTransition('reconnecting', 'ready')).toBe(true)
  })
})
