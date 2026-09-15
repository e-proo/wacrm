import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

describe('agent-loop structured tool safety', () => {
  it('uses native structured tools and does not export the legacy fenced parser', () => {
    const source = readFileSync(new URL('./agent-loop.ts', import.meta.url), 'utf8')
    expect(source).toContain('generateNativeAgentTurn')
    expect(source).not.toMatch(/export\s+(?:async\s+)?function\s+parseToolCall/)
  })
})
