import { describe, it, expect } from 'vitest'
import { parseToolCall } from './agent-loop'

// The tool-call wire protocol between the model and the runtime:
// the model emits a ```tool fenced JSON block; everything outside
// it is the customer-facing answer.

describe('parseToolCall', () => {
  it('extracts a fenced tool call and strips it from the text', () => {
    const raw = 'Let me check.\n```tool\n{"tool":"services.search","args":{"query":"coverage"}}\n```'
    const { call, text } = parseToolCall(raw)
    expect(call).toEqual({
      toolKey: 'services.search',
      args: { query: 'coverage' },
    })
    expect(text).toBe('Let me check.')
  })

  it('returns null for plain text (final answer)', () => {
    const { call, text } = parseToolCall('Here is your answer: 420 YER.')
    expect(call).toBeNull()
    expect(text).toBe('Here is your answer: 420 YER.')
  })

  it('drops malformed JSON blocks from the text (never crashes the loop)', () => {
    const raw = '```tool\n{not json}\n```'
    const { call, text } = parseToolCall(raw)
    expect(call).toBeNull()
    expect(text).toBe('')
  })

  it('honors only the FIRST tool block per turn and strips all blocks', () => {
    const raw = [
      '```tool',
      '{"tool":"intents.search","args":{}}',
      '```',
      'more text',
      '```tool',
      '{"tool":"services.get","args":{}}',
      '```',
    ].join('\n')
    const { call, text } = parseToolCall(raw)
    expect(call?.toolKey).toBe('intents.search')
    expect(text).toBe('more text')
  })

  it('defaults missing args to an empty object', () => {
    const raw = '```tool\n{"tool":"intents.search"}\n```'
    const { call } = parseToolCall(raw)
    expect(call?.args).toEqual({})
  })
})
