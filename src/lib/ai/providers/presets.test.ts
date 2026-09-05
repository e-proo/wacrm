import { describe, it, expect } from 'vitest'
import { getPreset, listAvailablePresets } from './presets'
import { ConnectionService } from '../connections/service'

describe('preset registry — Phase 04', () => {
  it('ships the three official fixed presets + gated custom pair', () => {
    const ids = listAvailablePresets({
      customEndpointsEnabled: false,
      privateEndpointsEnabled: false,
    }).map((p) => p.id)
    expect(ids).toEqual(['openai', 'anthropic', 'gemini', 'deepseek'])
  })

  it('gemini preset is fixed, server-rooted, header-auth (never query key)', () => {
    const gemini = getPreset('gemini')
    expect(gemini.protocol).toBe('gemini_native')
    expect(gemini.apiRootMode).toBe('fixed')
    expect(gemini.defaultApiRoot).toBe('https://generativelanguage.googleapis.com/v1beta/')
    expect(gemini.authStrategy).toBe('x_goog_api_key')
  })

  it('deepseek preset reuses the openai protocol — same adapter, zero new generate code', () => {
    const ds = getPreset('deepseek')
    expect(ds.protocol).toBe('openai')
    expect(ds.apiRootMode).toBe('fixed')
  })

  it('custom presets remain hidden until deployment opts in (ANY protocol)', () => {
    const hidden = listAvailablePresets({
      customEndpointsEnabled: false,
      privateEndpointsEnabled: true, // private flag alone must NOT unlock custom roots
    }).map((p) => p.id)
    expect(hidden).not.toContain('openai_compatible_custom')
    expect(hidden).not.toContain('anthropic_compatible_custom')
    expect(hidden).not.toContain('gemini_compatible_custom')
    const shown = listAvailablePresets({
      customEndpointsEnabled: true,
      privateEndpointsEnabled: false,
    }).map((p) => p.id)
    expect(shown).toContain('openai_compatible_custom')
    expect(shown).toContain('anthropic_compatible_custom')
    expect(shown).toContain('gemini_compatible_custom')
  })

  it('isCustomRootPreset derives the policy flag from the preset id', async () => {
    const { isCustomRootPreset } = await import('./presets')
    expect(isCustomRootPreset('openai')).toBe(false)
    expect(isCustomRootPreset('deepseek')).toBe(false)
    expect(isCustomRootPreset('openai_compatible_custom')).toBe(true)
    expect(isCustomRootPreset('gemini_compatible_custom')).toBe(true)
    // Unknown ids fail closed (policy validation on): defense after
    // preset renames or manually-edged rows.
    expect(isCustomRootPreset('legacy_mystery')).toBe(true)
  })

  it('creating a gemini connection stores the gemini_native protocol', () => {
    const svc = new ConnectionService({ accountId: 'acct-1', userId: 'user-1' })
    const created = svc.buildCreate({
      name: 'Gemini work',
      presetId: 'gemini',
      apiKey: 'AIza-test-key',
      apiRoot: null,
    })
    expect(created.protocol).toBe('gemini_native')
    expect(created.api_root).toBe('https://generativelanguage.googleapis.com/v1beta/')
    expect(created.encrypted_api_key).not.toContain('AIza')
  })

  it('gemini preset rejects root override like every fixed preset', () => {
    const svc = new ConnectionService({ accountId: 'a', userId: 'u' })
    expect(() =>
      svc.buildCreate({
        name: 'n',
        presetId: 'gemini',
        apiKey: 'k',
        apiRoot: 'http://169.254.169.254/',
      }),
    ).toThrowError(/fixed-root/)
  })
})
