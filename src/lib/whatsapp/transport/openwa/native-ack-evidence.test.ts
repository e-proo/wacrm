import { describe, expect, it } from 'vitest'
import {
  canonicalOwnPhone, parseNativeArchive, safeEvidence, validGatewayReference,
  verifiedGatewaySession,
} from './native-ack-evidence'

const id = 'true_123456@c.us_AABB'
const sid = 'existing-session'
const row = { sessionId: sid, waMessageId: id, direction: 'outgoing',
  status: 'read', body: 'PRIVATE MESSAGE', chatId: 'PRIVATE_CHAT',
  metadata: { apiKey: 'PRIVATE KEY' } }

describe('OW14-W05 native ACK read-only gateway evidence', () => {
  it('requires exact session and owner phone, rejecting rebinds and missing proof', () => {
    const gateway = { sessionId: sid, status: 'ready', phoneIdentity: '+967700000001' }
    expect(verifiedGatewaySession(gateway, sid, '967700000001@c.us')).toBe(true)
    expect(verifiedGatewaySession({...gateway, sessionId:'different'},sid,'967700000001')).toBe(false)
    expect(verifiedGatewaySession({...gateway, phoneIdentity:'967700000002'},sid,'967700000001')).toBe(false)
    expect(verifiedGatewaySession({...gateway, phoneIdentity:undefined},sid,'967700000001')).toBe(false)
    expect(verifiedGatewaySession({...gateway, status:'disconnected'},sid,'967700000001')).toBe(false)
    expect(canonicalOwnPhone('123456@lid')).toBeNull()
  })
  it('only queries well-formed upstream references', () => {
    expect(validGatewayReference(id)).toBe(true)
    expect(validGatewayReference('x'.repeat(201))).toBe(false)
    expect(validGatewayReference('bad id')).toBe(false)
    expect(validGatewayReference('bad\nid')).toBe(false)
  })
  it('recognizes one exact outbound archived row without revealing identity or content', () => {
    const result = parseNativeArchive({ total: 1, messages:[row] },id,sid)
    expect(result).toEqual({
      code:'archive_outbound_found', archive_status:'read',
      whatsapp_delivery_confirmed:false, outbound_resent:false,
    })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|AABB|967/)
  })
  it('does not interpret archive absence as failed delivery', () => {
    expect(parseNativeArchive({total:0,messages:[]},id,sid))
      .toEqual(safeEvidence('not_in_gateway_archive'))
  })
  it('fails closed on duplicate, cross-session, inbound, mismatched or malformed results', () => {
    expect(parseNativeArchive({total:2,messages:[row,row]},id,sid).code)
      .toBe('ambiguous_gateway_archive')
    for (const bad of [
      { ...row, sessionId: 'different' },
      { ...row, direction: 'incoming' },
      { ...row, waMessageId: id+'x' },
      { ...row, status: 'unconfirmed' },
    ]) expect(parseNativeArchive({total:1,messages:[bad]},id,sid).code)
      .toBe('unverifiable_gateway_response')
    expect(parseNativeArchive({total:1,messages:[]},id,sid).code)
      .toBe('unverifiable_gateway_response')
    expect(parseNativeArchive({messages:[row]},id,sid).code)
      .toBe('unverifiable_gateway_response')
  })
})
