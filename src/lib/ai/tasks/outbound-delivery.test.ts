import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('Agent Task outbound delivery boundary', () => {
  it('claims durable transport ownership before invoking Meta send helpers', () => {
    const source = readFileSync(
      new URL('./outbound-delivery.ts', import.meta.url),
      'utf8',
    )

    const claim = source.indexOf('claim_agent_task_outbound_message')
    const sendText = source.indexOf('transport.sendText')
    const sendTemplate = source.indexOf('transport.sendTemplate')

    expect(claim).toBeGreaterThanOrEqual(0)
    expect(sendText).toBeGreaterThan(claim)
    expect(sendTemplate).toBeGreaterThan(claim)
  })

  it('never blind-retries an ambiguous post-claim transport outcome', () => {
    const source = readFileSync(
      new URL('./outbound-delivery.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain("'mark_agent_task_outbound_reconciliation'")
    expect(source).toContain("status: 'requires_reconciliation'")
    expect(source).not.toContain('retry_agent_task_target_claim')
  })

  it('does not expose a raw whatsapp.send model tool', () => {
    const source = readFileSync(
      new URL('./outbound-delivery.ts', import.meta.url),
      'utf8',
    )

    expect(source).not.toContain('whatsapp.send')
    expect(source).not.toContain('modelExposed')
  })
  it('routes Agent Task sends with an explicit agent workload (including text)', () => {
    const delivery = readFileSync(
      new URL('./outbound-delivery.ts', import.meta.url),
      'utf8',
    )
    const sendCore = readFileSync(
      new URL('../../automations/meta-send.ts', import.meta.url),
      'utf8',
    )

    expect(delivery.match(/workload: 'agent',/g)).toHaveLength(2)
    expect(sendCore).toContain('input.workload ??')
    expect(sendCore).toContain('idempotencyKey:reservationValue??undefined')
  })

})
