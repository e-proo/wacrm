import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('OpenWA outbound reviews across all current and future sessions', () => {
  it('keeps one account-wide review hub in the delivery tab, outside all session cards', () => {
    const connections = readFileSync('src/components/settings/openwa-connections.tsx', 'utf8')
    const pilot = readFileSync('src/components/settings/openwa-pilot-controls.tsx', 'utf8')
    const sessionStart = connections.indexOf("{view === 'sessions' &&")
    const pilotStart = connections.indexOf("{view === 'pilot' &&", sessionStart)
    const deliveryStart = connections.indexOf("{view === 'delivery' &&", pilotStart)
    const dialogsStart = connections.indexOf("{view === 'sessions' && <>", deliveryStart)
    expect(sessionStart).toBeGreaterThan(0)
    expect(pilotStart).toBeGreaterThan(sessionStart)
    expect(deliveryStart).toBeGreaterThan(pilotStart)
    expect(dialogsStart).toBeGreaterThan(deliveryStart)

    const sessions = connections.slice(sessionStart, pilotStart)
    const delivery = connections.slice(deliveryStart, dialogsStart)
    expect(sessions).toContain('{connections.map((connection) => <Card')
    expect(sessions).toContain('connection.outbound_review?.unreviewed_count')
    expect(sessions).toContain('focusReview(connection.id)')
    expect(sessions).not.toContain('<OpenWAOutboundReviewHub ')
    expect(sessions).not.toContain('<OpenWAOutboundReview ')
    expect(delivery.match(/<OpenWAOutboundReviewHub /g)).toHaveLength(1)
    expect(delivery).not.toContain('{connections.map((connection) => <Card')
    expect(delivery.match(/<OpenWAReconciliation /g)).toHaveLength(1)
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
