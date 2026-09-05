import { describe, it, expect } from 'vitest'
import { ensureTrailingSlash, joinApiPath } from './url-join'

describe('ensureTrailingSlash', () => {
  it('adds the slash when missing and never doubles it', () => {
    expect(ensureTrailingSlash('https://api.x/v1')).toBe('https://api.x/v1/')
    expect(ensureTrailingSlash('https://api.x/v1/')).toBe('https://api.x/v1/')
  })
})

describe('joinApiPath — the Phase 03 root matrix', () => {
  it('default OpenAI root preserves /v1 (no /v1/v1)', () => {
    const u = joinApiPath('https://api.openai.com/v1/', 'models')
    expect(u.toString()).toBe('https://api.openai.com/v1/models')
    expect(u.pathname).not.toContain('v1/v1')
  })

  it('root WITHOUT trailing slash still keeps its version segment', () => {
    // The classic `new URL('chat/completions', '…/v1')` bug would drop
    // `v1` — our helper must not.
    const u = joinApiPath('https://api.openai.com/v1', 'chat/completions')
    expect(u.pathname).toBe('/v1/chat/completions')
  })

  it('version-less deepseek-style root joins correctly', () => {
    const root = 'https://api.deepseek.com/'
    expect(joinApiPath(root, 'chat/completions').toString()).toBe(
      'https://api.deepseek.com/chat/completions',
    )
    expect(joinApiPath(root, 'models').toString()).toBe('https://api.deepseek.com/models')
  })

  it('custom gateway path under a prefix is preserved', () => {
    const u = joinApiPath('https://gw.example.com/t/acme/v1/', 'chat/completions')
    expect(u.pathname).toBe('/t/acme/v1/chat/completions')
  })

  it('collapses a double version if a caller passes v1/... onto a /v1/ root', () => {
    const u = joinApiPath('https://api.openai.com/v1/', 'v1/models')
    expect(u.pathname).toBe('/v1/models')
  })

  it('accepts a URL object as root', () => {
    const root = new URL('https://api.openai.com/v1/')
    expect(joinApiPath(root, 'models').toString()).toBe('https://api.openai.com/v1/models')
  })

  it('rejects absolute/traversal paths that could escape the root', () => {
    expect(() => joinApiPath('https://api.openai.com/v1/', 'https://evil.example/x')).toThrowError()
    expect(() => joinApiPath('https://api.openai.com/v1/', '/etc/passwd')).toThrowError()
    expect(() => joinApiPath('https://api.openai.com/v1/', '../secret')).toThrowError()
    expect(() => joinApiPath('https://api.openai.com/v1/', ' ')).toThrowError()
  })
})
