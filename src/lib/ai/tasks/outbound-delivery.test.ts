import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('Agent Task outbound delivery boundary', () => {
  it('claims durable transport ownership before invoking Meta send helpers', () => {
    const source = readFileSync(
      new URL('./outbound-delivery.ts', import.meta.url),
      'utf8',
    )

    const claim = source.indexOf('claim_bound_agent_task_outbound_message')
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
    expect(sendCore).toContain('resolveConversationTransport(db,input.accountId,input.conversationId,input.connectionId)')
    const reservation = readFileSync(
      new URL('./outbound-runtime.ts', import.meta.url),
      'utf8',
    )
    expect(reservation).toContain("'reserve_bound_agent_task_outbound_message'")
    expect(delivery).toContain("'claim_bound_agent_task_outbound_message'")
    expect(delivery).toContain('expectedProvider: row.provider!')
    expect(delivery).toContain('connectionId: row.connection_id!')
    const preclaim = delivery.indexOf('await preflightAgentTaskConnection(')
    const claim = delivery.indexOf("'claim_bound_agent_task_outbound_message'")
    expect(preclaim).toBeGreaterThanOrEqual(0)
    expect(claim).toBeGreaterThan(preclaim)
    expect(delivery).toContain("reason: 'connection_preflight_failed'")
  })
  it('classifies only typed, proven OpenWA pre-dispatch denials as terminal unsent', () => {
    const delivery = readFileSync(
      new URL('./outbound-delivery.ts', import.meta.url), 'utf8',
    )
    const worker = readFileSync(
      new URL('./outbound-worker.ts', import.meta.url), 'utf8',
    )
    const before = delivery.indexOf('error instanceof OpenWAPreDispatchDenied')
    const after = delivery.indexOf("'mark_agent_task_outbound_reconciliation'")
    expect(delivery).toContain('error.providerDispatchAttempted === false')
    expect(delivery).toContain("row.provider === 'openwa'")
    expect(delivery).toContain("'finalize_agent_task_outbound_pre_dispatch_denial'")
    expect(delivery).toContain("status: 'denied'")
    expect(delivery).toContain("reason: 'openwa_pre_dispatch_denied'")
    expect(before).toBeGreaterThan(-1)
    expect(after).toBeGreaterThan(before)
    expect(worker).toContain("delivery.reason === 'openwa_pre_dispatch_denied'")
    expect(worker).toContain('result.denied += 1')
    expect(worker).toContain("if (delivery.status === 'requires_reconciliation')")
  })

})
