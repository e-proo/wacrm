import { describe, expect, it } from 'vitest'
import {
  SERVICE_REVISION_CONFLICT_MARKERS,
  errorHasAnyMarker,
  getErrorMessage,
} from './version-conflict'

describe('shared version conflict helpers', () => {
  it('extracts messages without assuming a Supabase error class', () => {
    expect(getErrorMessage({ message: 'boom' }, 'fallback')).toBe('boom')
    expect(getErrorMessage(null, 'fallback')).toBe('fallback')
  })

  it('matches service revision concurrency markers', () => {
    expect(
      errorHasAnyMarker(
        { message: 'SERVICE_VERSION_CHANGED: expected 2' },
        SERVICE_REVISION_CONFLICT_MARKERS,
      ),
    ).toBe(true)
    expect(
      errorHasAnyMarker(
        { message: 'SERVICE_CURRENT_REVISION_CHANGED' },
        SERVICE_REVISION_CONFLICT_MARKERS,
      ),
    ).toBe(true)
    expect(
      errorHasAnyMarker(
        { message: 'SOME_OTHER_FAILURE' },
        SERVICE_REVISION_CONFLICT_MARKERS,
      ),
    ).toBe(false)
  })
})
