import { describe, expect, it } from 'vitest'
import {
  RuntimeCircuitOpenError,
  circuitErrorCode,
} from './circuit-breaker'

describe('runtime circuit breaker contracts', () => {
  it('produces stable scoped open codes', () => {
    expect(
      new RuntimeCircuitOpenError('provider', 'provider-id').code,
    ).toBe('AI_PROVIDER_CIRCUIT_OPEN')
    expect(
      new RuntimeCircuitOpenError('task_type', 'coverage.sourcing@1').code,
    ).toBe('AI_TASK_TYPE_CIRCUIT_OPEN')
  })

  it('redacts arbitrary provider/tool errors into bounded audit codes', () => {
    expect(circuitErrorCode(new Error('HTTP 503: provider unavailable')))
      .toBe('HTTP_503_PROVIDER_UNAVAILABLE')
    expect(circuitErrorCode(' tool timeout ')).toBe('TOOL_TIMEOUT')
    expect(circuitErrorCode(null)).toBe('UNKNOWN_FAILURE')
  })
})
