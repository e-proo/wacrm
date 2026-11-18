import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('OpenWA outbound reviews across all current and future sessions', () => {
  it('renders one account-level hub, never one full alert per session card', () => {
    const connections = readFileSync(
      'src/components/settings/openwa-connections.tsx', 'utf8')
    const pilot = readFileSync(
      'src/components/settings/openwa-pilot-controls.tsx', 'utf8')
    const cardsAt = connections.indexOf('{connections.map((connection) => <Card')
    expect(cardsAt).toBeGreaterThan(0)
    const summary = connections.slice(0, cardsAt)
    const cards = connections.slice(cardsAt)
    expect(summary.match(/<OpenWAOutboundReviewHub /g)).toHaveLength(1)
    expect(cards).not.toContain('<OpenWAOutboundReview ')
    expect(cards).toContain('connection.outbound_review?.unreviewed_count')
    expect(cards).toContain('focusReview(connection.id)')
    expect(pilot).not.toContain('<OpenWAOutboundReview')
  })

  it('fetches only the selected session when the operator expands the summary', () => {
    const hub = readFileSync(
      'src/components/settings/openwa-outbound-review-hub.tsx', 'utf8')
    const detail = readFileSync(
      'src/components/settings/openwa-outbound-review.tsx', 'utf8')
    expect(hub).toContain('expanded && summary.unreviewed > 0')
    expect(hub).toContain('<OpenWAOutboundReview key={active.id} connectionId={active.id}')
    expect(hub).toContain('onSelectConnection(connection.id)')
    expect(hub).not.toContain('fetch(') // no per-connection N+1 queue requests
    expect(detail).toContain('if (embedded) void load()')
    expect(detail).toContain('action: \'acknowledge_no_resend\'')
    expect(detail).toContain('confirm_no_resend: true')
  })
})
