import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('native agent final-turn safety', () => {
  it('forces OpenAI-compatible providers into text-only mode when no tools are offered', () => {
    const source = readFileSync(new URL('./native-agent-tools.ts', import.meta.url), 'utf8')
    expect(source).toContain("tool_choice: tools.length ? 'auto' : 'none'")
    expect(source).toContain("input.tools.length === 0 && rawCalls.length > 0")
    expect(source).toContain("code: 'tool_call_not_allowed'")
  })
})
