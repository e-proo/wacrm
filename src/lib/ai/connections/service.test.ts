import { describe, it, expect } from 'vitest'
import { ConnectionService } from './service'
import { devFingerprint } from './service'

describe('ConnectionService.buildCreate', () => {
  it('encrypts the API key and computes a fingerprint', () => {
    const svc = new ConnectionService({ accountId: 'acct-1', userId: 'user-1' })
    const out = svc.buildCreate({
      name: 'OpenAI primary',
      presetId: 'openai',
      apiKey: 'sk-test-key',
      apiRoot: null,
    })

    expect(out.name).toBe('OpenAI primary')
    expect(out.preset_id).toBe('openai')
    expect(out.protocol).toBe('openai')
    // The fixed-root preset ignores any supplied root and uses the default.
    expect(out.api_root).toBe('https://api.openai.com/v1/')
    // encrypted — not the plaintext.
    expect(out.encrypted_api_key).not.toContain('sk-test-key')
    expect(out.encrypted_api_key).toMatch(/^[0-9a-f]{12,}:[0-9a-f]+:[0-9a-f]+$/)
    expect(out.connection_fingerprint).toMatch(/^fp_/)
  })

  it('rejects a custom api_root for a fixed-root preset', () => {
    const svc = new ConnectionService({ accountId: 'acct-1', userId: 'user-1' })
    expect(() =>
      svc.buildCreate({
        name: 'Evil',
        presetId: 'openai',
        apiKey: 'sk-test',
        apiRoot: 'http://169.254.169.254/latest',
      }),
    ).toThrowError(/fixed-root/)
  })

  it('requires an api_key', () => {
    const svc = new ConnectionService({ accountId: 'acct-1', userId: 'user-1' })
    expect(() =>
      svc.buildCreate({ name: 'X', presetId: 'openai', apiKey: '', apiRoot: null }),
    ).toThrowError(/api_key is required/)
  })
})

describe('ConnectionService.buildUpdate', () => {
  const svc = () => new ConnectionService({ accountId: 'acct-1', userId: 'user-1' })
  const existing = {
    encrypted_api_key: 'old-enc-key',
    api_root: 'https://api.openai.com/v1/',
    preset_id: 'openai',
  }

  it('reuses the existing key when api_key is omitted', () => {
    const out = svc().buildUpdate(existing, {})
    expect(out).toEqual({})
  })

  it('throws when trying to clear the key via PATCH with null', () => {
    expect(() =>
      svc().buildUpdate(existing, { apiKey: null }),
    ).toThrowError(/separate explicit action/)
  })

  it('re-encrypts and recomputes fingerprint when a new key is supplied', () => {
    const out = svc().buildUpdate(existing, { apiKey: 'sk-new-key' })
    expect(out.encrypted_api_key).not.toContain('sk-new-key')
    expect(out.connection_fingerprint).toMatch(/^fp_/)
  })

  it('key rotation revokes verification (status → unverified, verified_at cleared)', () => {
    const out = svc().buildUpdate(existing, { apiKey: 'sk-new-key' })
    expect(out.status).toBe('unverified')
    expect(out.verified_at).toBeNull()
  })

  it('fingerprint on key-only patch uses the EXISTING root (bug guard)', () => {
    const withRoot = (r: string) => ({ ...existing, api_root: r })
    const a = svc().buildUpdate(withRoot('https://api.deepseek.com/'), { apiKey: 'k1' })
    const b = svc().buildUpdate(withRoot('https://api.deepseek.com/'), { apiKey: 'k1' })
    const c = svc().buildUpdate(withRoot('https://api.openai.com/v1/'), { apiKey: 'k1' })
    expect(a.connection_fingerprint).toBe(b.connection_fingerprint)
    expect(a.connection_fingerprint).not.toBe(c.connection_fingerprint)
  })

  it('no-op root patch (same value) does NOT revoke verification', () => {
    const out = svc().buildUpdate(existing, { apiRoot: 'https://api.openai.com/v1/' })
    expect(out.status).toBeUndefined()
    expect(out.api_root).toBeUndefined()
  })

  it('name-only patch does not touch credentials or status', () => {
    const out = svc().buildUpdate(existing, { name: 'renamed' })
    expect(out).toEqual({ name: 'renamed' })
  })
})

describe('devFingerprint', () => {
  it('produces a fp_ prefixed random token', () => {
    expect(devFingerprint()).toMatch(/^fp_[0-9a-f]{32}$/)
  })
})
