import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, HANDOFF_SENTINEL } from './defaults'

// The tool-call protocol must be taught ONLY when the revision
// actually carries a tool catalog — and the handoff guidance must
// soften to "try a tool first" when tools exist. This is the exact
// gap that shipped `tools=0` on every run: grants lived in the DB
// but the model was never told they exist or how to call them.

describe('buildSystemPrompt tool catalog section', () => {
  it('omits the tools section entirely when no catalog is given', () => {
    const prompt = buildSystemPrompt({
      userPrompt: 'You are ACME support.',
      mode: 'auto_reply',
      knowledge: ['[1] some excerpt'],
    })
    expect(prompt).not.toContain('```tool')
    expect(prompt).not.toContain('System tools')
  })

  it('teaches the ```tool protocol and quotes the granted tool name', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      tools: '- coverage.get_rates (read): Read the CURRENT published commission rate board. | args: {scope?: string}',
    })
    expect(prompt).toContain('System tools')
    expect(prompt).toContain('```tool')
    expect(prompt).toContain('coverage.get_rates')
    // The model must be told numbers come only from a tool result.
    expect(prompt).toMatch(/never from memory|fresh \[tool result\]/)
    // ...and that confirmation claims need ok:true.
    expect(prompt).toMatch(/"ok": true/)
  })

  it('auto-reply falls back to handoff when no tool answers, but softens to "try a tool" with a catalog', () => {
    const withTools = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      knowledge: ['[1] policy only'],
      tools: '- services.search (read): search the catalog.',
    })
    expect(withTools).toMatch(/call one of the System tools below/)
    const withoutTools = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      knowledge: ['[1] policy only'],
    })
    expect(withoutTools).toContain(HANDOFF_SENTINEL)
  })
})
