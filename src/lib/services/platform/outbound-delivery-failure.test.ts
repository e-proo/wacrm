import { describe, it, expect } from 'vitest'
import { OpenWAPreDispatchDenied } from '@/lib/whatsapp/transport/guardrails'
import { classifyBusinessOutboundFailure } from './outbound-delivery-failure'

const beforeProvider = new OpenWAPreDispatchDenied('Pilot denied the recipient', 'pilot_recipient_not_allowlisted')
const failed = { id: 'm1', status: 'failed', message_id: null, provider_message_id: null }

describe('durable business-event send failure classification', () => {
  it('does not mistake a finalized Pilot pre-dispatch denial for a provider timeout', () => {
    expect(classifyBusinessOutboundFailure({error: beforeProvider,reservation: failed})).toEqual({
      status: 'failed', reason: 'OPENWA_PRE_DISPATCH_DENIED:pilot_recipient_not_allowlisted',
    })
  })
  it('requires reconciliation when the message may still be sending', () => {
    expect(classifyBusinessOutboundFailure({error: beforeProvider,reservation: {...failed,status:'sending'}}).status)
      .toBe('requires_reconciliation')
  })
  it('never treats an ambiguous provider timeout as proved pre-dispatch', () => {
    expect(classifyBusinessOutboundFailure({error: new Error('timeout'),reservation:failed}).status)
      .toBe('requires_reconciliation')
  })
  it('fails closed on missing reservation evidence because the lookup failed', () => {
    expect(classifyBusinessOutboundFailure({error:beforeProvider,reservation:null,reservationLookupFailed:true}).status)
      .toBe('requires_reconciliation')
  })
  it('marks a definite error before reservation as failed', () => {
    expect(classifyBusinessOutboundFailure({error:new Error('invalid recipient'),reservation:null}).status)
      .toBe('failed')
  })
})
