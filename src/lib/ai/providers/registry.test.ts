import { describe, it, expect } from 'vitest'
import { getAdapter, listRegisteredProtocols } from './registry'
import { AiError } from '../types'

describe('adapter registry', () => {
  it('exposes the three registered protocols', () => {
    expect(listRegisteredProtocols().sort()).toEqual([
      'anthropic',
      'gemini_native',
      'openai',
    ])
  })

  it('resolves each registered protocol to its adapter', () => {
    expect(getAdapter('openai').protocol).toBe('openai')
    expect(getAdapter('anthropic').protocol).toBe('anthropic')
    expect(getAdapter('gemini_native').protocol).toBe('gemini_native')
  })

  it('rejects an unknown protocol with the legacy unsupported_provider code', () => {
    // Cast through unknown to exercise the runtime guard.
    expect(() => getAdapter('gemini' as never)).toThrowError(AiError)
    try {
      getAdapter('gemini' as never)
    } catch (err) {
      expect(err).toBeInstanceOf(AiError)
      expect((err as AiError).code).toBe('unsupported_provider')
      expect((err as AiError).status).toBe(400)
    }
  })
})