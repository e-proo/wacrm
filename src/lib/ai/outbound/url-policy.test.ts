import { describe, it, expect } from 'vitest'
import { validateUrl, isBlockedIPv4, isBlockedIPv6, resolveTarget } from './url-policy'

describe('validateUrl — scheme / host / port', () => {
  it('accepts a clean HTTPS URL', () => {
    const r = validateUrl('https://api.openai.com/v1/')
    expect(r.error).toBeNull()
    expect(r.blockedReason).toBeNull()
    expect(r.url?.hostname).toBe('api.openai.com')
  })

  it('rejects non-HTTPS schemes', () => {
    expect(validateUrl('http://api.openai.com/v1/').blockedReason).toBe('scheme_not_allowed')
  })

  it('rejects username/password fragments in the URL', () => {
    expect(validateUrl('https://user:pass@api.openai.com/').blockedReason).toBe('credentials_in_url')
    expect(validateUrl('https://api.openai.com/#frag').blockedReason).toBe('fragment_not_allowed')
  })

  it('blocks localhost when allowPrivate is off', () => {
    expect(validateUrl('https://localhost/').blockedReason).toBe('localhost_blocked')
    expect(validateUrl('https://foo.localhost/').blockedReason).toBe('localhost_blocked')
  })

  it('allows localhost only when allowPrivate is true', () => {
    expect(validateUrl('https://localhost/', { allowPrivate: true }).blockedReason).toBeNull()
  })

  it('rejects non-443 ports without an allowlist', () => {
    expect(validateUrl('https://api.openai.com:8080/').blockedReason).toBe('port_not_allowed')
  })
})

describe('IPv4 classification', () => {
  it('blocks private + loopback + metadata + test ranges', () => {
    expect(isBlockedIPv4('10.0.0.1')).toBe(true)
    expect(isBlockedIPv4('172.16.0.1')).toBe(true)
    expect(isBlockedIPv4('192.168.1.1')).toBe(true)
    expect(isBlockedIPv4('127.0.0.1')).toBe(true)
    expect(isBlockedIPv4('169.254.169.254')).toBe(true) // cloud metadata
    expect(isBlockedIPv4('100.64.0.1')).toBe(true) // CGNAT
    expect(isBlockedIPv4('192.0.2.1')).toBe(true) // TEST-NET
    expect(isBlockedIPv4('0.0.0.0')).toBe(true)
  })

  it('blocks TEST-NET ranges (documentation addresses)', () => {
    expect(isBlockedIPv4('192.0.2.1')).toBe(true)
    expect(isBlockedIPv4('198.51.100.1')).toBe(true)
    expect(isBlockedIPv4('203.0.113.1')).toBe(true)
  })

  it('allows a genuinely public address', () => {
    expect(isBlockedIPv4('8.8.8.8')).toBe(false) // real public DNS
  })
})

describe('IPv6 classification', () => {
  it('blocks loopback + link-local + unique-local + multicast + mapped-v4-private', () => {
    expect(isBlockedIPv6('::1')).toBe(true)
    expect(isBlockedIPv6('::')).toBe(true)
    expect(isBlockedIPv6('fe80::1')).toBe(true)
    expect(isBlockedIPv6('fc00::1')).toBe(true)
    expect(isBlockedIPv6('fd00::1')).toBe(true)
    expect(isBlockedIPv6('ff02::1')).toBe(true)
    expect(isBlockedIPv6('::ffff:127.0.0.1')).toBe(true) // mapped loopback
    expect(isBlockedIPv6('::ffff:10.0.0.1')).toBe(true) // mapped private
  })
})

describe('resolveTarget — multi-answer DNS', () => {
  it('blocks when ANY resolved address is private', async () => {
    const resolver = () =>
      Promise.resolve({ addresses: ['8.8.8.8', '169.254.169.254'] })
    const url = new URL('https://api.openai.com/')
    const t = await resolveTarget(url, { resolver })
    expect(t.allowed).toBe(false)
    expect(t.reason).toMatch(/blocked/)
  })

  it('an unresolvable hostname is REFUSED, not waved through', async () => {
    const resolver = () => Promise.resolve({ addresses: [] })
    const t = await resolveTarget(new URL('https://nowhere.invalid/'), { resolver })
    expect(t.allowed).toBe(false)
    expect(t.reason).toMatch(/resolve/)
  })

  it('IP-literal hosts are classified directly (bypass closed)', async () => {
    // No resolver stub: a literal must never reach DNS or pass by
    // emptiness. Cloud metadata endpoint is the canonical attack.
    const meta = await resolveTarget(new URL('https://169.254.169.254/latest/meta-data/'))
    expect(meta.allowed).toBe(false)
    const loopback = await resolveTarget(new URL('https://127.0.0.1/'))
    expect(loopback.allowed).toBe(false)
    const v6loop = await resolveTarget(new URL('https://[::1]/'))
    expect(v6loop.allowed).toBe(false)
    // public literal passes (allowed in policy; port rules still apply)
    const pub = await resolveTarget(new URL('https://8.8.8.8/'))
    expect(pub.allowed).toBe(true)
  })

  it('allows when all resolved addresses are public', async () => {
    const resolver = () => Promise.resolve({ addresses: ['8.8.8.8', '1.1.1.1'] })
    const url = new URL('https://api.openai.com/')
    const t = await resolveTarget(url, { resolver })
    expect(t.allowed).toBe(true)
    expect(t.ips).toEqual(['8.8.8.8', '1.1.1.1'])
  })
})
