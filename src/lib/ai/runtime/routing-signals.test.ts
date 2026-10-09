import { describe, expect, it } from 'vitest'
import { detectRoutingLanguage, normalizeRouteTag } from './routing-signals'

describe('routing signals', () => {
  it('normalizes free-text tag names the same way at runtime', () => {
    expect(normalizeRouteTag('  VIP Customer ')).toBe('vip customer')
  })

  it('detects clear Arabic and English text conservatively', () => {
    expect(detectRoutingLanguage('مرحبا كيف يمكنني الاستفسار؟')).toBe('ar')
    expect(detectRoutingLanguage('Hello, I need help please')).toBe('en')
  })

  it('does not guess on mixed or symbol-only messages', () => {
    expect(detectRoutingLanguage('مرحبا hello')).toBeNull()
    expect(detectRoutingLanguage('👍 123')).toBeNull()
  })
})
