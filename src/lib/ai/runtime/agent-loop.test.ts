import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

describe('agent-loop structured tool safety', () => {
  it('uses native structured tools and does not export the legacy fenced parser', () => {
    const source = readFileSync(new URL('./agent-loop.ts', import.meta.url), 'utf8')
    expect(source).toContain('generateNativeAgentTurn')
    expect(source).not.toMatch(/export\s+(?:async\s+)?function\s+parseToolCall/)
  })

  it('fails closed on concrete current FX questions until the authoritative tool succeeds', () => {
    const source = readFileSync(new URL('./agent-loop.ts', import.meta.url), 'utf8')
    expect(source).toContain("requiresFreshFxRate(latestCustomerText)")
    expect(source).toContain("exchange_rates.get_current")
    expect(source).toContain('FX_CURRENT_RATE_TOOL_UNAVAILABLE')
    expect(source).toContain('Conversation history and retrieved knowledge are NOT authoritative for current FX prices')
    expect(source).toContain("call.toolKey === 'exchange_rates.get_current' && outcome.result.ok")
  })
})
