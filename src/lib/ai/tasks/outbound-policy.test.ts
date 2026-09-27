import { describe, expect, it } from 'vitest'
import {
  AgentTaskOutboundPolicyRegistry,
  assertValidOutboundMessageCandidate,
  type AgentTaskOutboundMessagePolicy,
} from './outbound-policy'

const policy = (
  key = 'coverage.sourcing_message',
  domain = 'coverage',
): AgentTaskOutboundMessagePolicy => ({
  key,
  domain,
  version: 1,
  async prepare() {
    return { kind: 'text', text: 'hello' }
  },
})

describe('AgentTaskOutboundPolicyRegistry', () => {
  it('registers a same-domain policy by stable key', () => {
    const registry = new AgentTaskOutboundPolicyRegistry().register(
      'coverage',
      policy(),
    )
    expect(registry.get('coverage.sourcing_message', 1)?.domain).toBe('coverage')
  })

  it('rejects cross-domain ownership', () => {
    expect(() =>
      new AgentTaskOutboundPolicyRegistry().register(
        'services',
        policy(),
      ),
    ).toThrow(/domain ownership mismatch/)
  })

  it('allows multiple versions but rejects a duplicate exact policy version', () => {
    const registry = new AgentTaskOutboundPolicyRegistry().register(
      'coverage',
      policy(),
    )
    registry.register('coverage', { ...policy(), version: 2 })
    expect(registry.get('coverage.sourcing_message', 2)?.version).toBe(2)
    expect(() => registry.register('coverage', policy())).toThrow(/Duplicate/)
  })
})

describe('assertValidOutboundMessageCandidate', () => {
  it('normalizes free-form text but never decides whether it may be sent', () => {
    expect(
      assertValidOutboundMessageCandidate({
        kind: 'text',
        text: '  hello supplier  ',
      }),
    ).toEqual({ kind: 'text', text: 'hello supplier' })
  })

  it('normalizes a template candidate', () => {
    expect(
      assertValidOutboundMessageCandidate({
        kind: 'template',
        templateName: ' coverage_supplier_request ',
        language: ' en_US ',
        params: ['Sanaa', '1000'],
      }),
    ).toEqual({
      kind: 'template',
      templateName: 'coverage_supplier_request',
      language: 'en_US',
      params: ['Sanaa', '1000'],
    })
  })

  it('rejects empty or oversized model text', () => {
    expect(() =>
      assertValidOutboundMessageCandidate({ kind: 'text', text: '   ' }),
    ).toThrow(/OUTBOUND_TEXT_EMPTY/)

    expect(() =>
      assertValidOutboundMessageCandidate({
        kind: 'text',
        text: 'x'.repeat(4097),
      }),
    ).toThrow(/OUTBOUND_TEXT_TOO_LONG/)
  })
})
