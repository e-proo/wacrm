import { describe, expect, it } from 'vitest'
import { classifyAckLocalCorrelation } from './ack-triage'

describe('OW14-W05 exact local ACK correlation (read-only)', () => {
  const id = 'native_123@lid_MSG'
  it('never guesses a match from a similar or different ID', () => {
    expect(classifyAckLocalCorrelation(id, [{provider_message_id:id+'x',sender_type:'bot'}],[]))
      .toBe('needs_native_review')
    expect(classifyAckLocalCorrelation(id, [],[])).toBe('needs_native_review')
    expect(classifyAckLocalCorrelation('',[],[])).toBe('needs_native_review')
  })
  it('identifies an outbound WACRM row or a broadcast recipient as candidates only', () => {
    expect(classifyAckLocalCorrelation(id,[{provider_message_id:id,sender_type:'agent'}],[]))
      .toBe('candidate_outbound_message')
    expect(classifyAckLocalCorrelation(id,[{provider_message_id:id,sender_type:'bot'}],[]))
      .toBe('candidate_outbound_message')
    expect(classifyAckLocalCorrelation(id,[],[{provider_message_id:id}]))
      .toBe('candidate_broadcast_recipient')
  })
  it('does not promote an inbound customer message to outbound delivery proof', () => {
    expect(classifyAckLocalCorrelation(id,[{provider_message_id:id,sender_type:'customer'}],[]))
      .toBe('inbound_only')
  })
  it('treats missing/unrecognized sender types as ambiguous, not outbound proof', () => {
    expect(classifyAckLocalCorrelation(id,[{provider_message_id:id,sender_type:null}],[]))
      .toBe('ambiguous_local_rows')
    expect(classifyAckLocalCorrelation(id,[{provider_message_id:id,sender_type:'unrecognized'}],[]))
      .toBe('ambiguous_local_rows')
  })
  it('marks duplicate local rows and mixed inbound/outbound identities ambiguous', () => {
    expect(classifyAckLocalCorrelation(id,[{provider_message_id:id,sender_type:'bot'}],[{provider_message_id:id}]))
      .toBe('ambiguous_local_rows')
    expect(classifyAckLocalCorrelation(id,[
      {provider_message_id:id,sender_type:'customer'},
      {provider_message_id:id,sender_type:'agent'},
    ],[])).toBe('ambiguous_local_rows')
  })
})
