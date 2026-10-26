import { describe, expect, it } from 'vitest'

import { assertMetaOutboundProviderBoundary } from './meta-outbound-boundary'

describe('Meta outbound provider boundary', () => {
  it('preserves Meta and legacy/null compatibility', () => {
    expect(() => assertMetaOutboundProviderBoundary('meta_cloud')).not.toThrow()
    expect(() => assertMetaOutboundProviderBoundary(null)).not.toThrow()
  })

  it('fails closed instead of leaking a Meta send into an OpenWA conversation', () => {
    expect(() => assertMetaOutboundProviderBoundary('openwa')).toThrow(
      'unsupported_capability: OpenWA outbound is not enabled before OW-7',
    )
  })
})
