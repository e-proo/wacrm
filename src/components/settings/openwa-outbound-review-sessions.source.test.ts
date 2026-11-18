import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('OpenWA outbound reviews for every current and future connection', () => {
  it('mounts the review once per session card rather than only in selected Pilot panel', () => {
    const connections = readFileSync(
      'src/components/settings/openwa-connections.tsx', 'utf8')
    const pilot = readFileSync(
      'src/components/settings/openwa-pilot-controls.tsx', 'utf8')
    const cards = connections.slice(connections.indexOf('{connections.map((connection) => <Card'))
    expect(cards).toContain('<OpenWAOutboundReview key={connection.id} connectionId={connection.id}')
    expect(cards).toContain('connection.outbound_review?.unreviewed_count')
    expect(cards).toContain('connection.outbound_review?.reviewed_uncertain_count')
    expect(pilot).not.toContain('<OpenWAOutboundReview')
  })
})
