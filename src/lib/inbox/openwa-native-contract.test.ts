import { describe, expect, it, vi } from 'vitest'
import type { OpenWAClient, OpenWASessionStatus } from '@/lib/whatsapp/transport/openwa/client'
import { OPENWA_NATIVE_CONTRACT, parseOpenWANativeContract, verifyOpenWANativeContract } from './openwa-native-contract'
const ready: OpenWASessionStatus = { status: 'ready', sessionId: 'fixture', raw: { engineLoaded: true } }
const auth = { valid: true, engineType: 'whatsapp-web.js' }
const health = { status: 'ok', version: '0.29.1' }
describe('single connection native namespace contract', () => {
  it('requires authenticated exact reviewed version and live engine', () => {
    expect(parseOpenWANativeContract(auth, health, ready)).toEqual(OPENWA_NATIVE_CONTRACT)
    for (const a of [null, {}, { ...auth, valid: false }, { ...auth, engineType: null }])
      expect(() => parseOpenWANativeContract(a, health, ready)).toThrow('namespace_engine_unverified')
    for (const engineType of ['baileys', 'mock', 'WHATSAPP-WEB.JS'])
      expect(() => parseOpenWANativeContract({ ...auth, engineType }, health, ready)).toThrow('namespace_engine_unsupported')
    for (const h of [null, {}, { ...health, version: '0.29.0' }, { ...health, version: '0.30.0' }, { ...health, version: '0.29.1-custom' }])
      expect(() => parseOpenWANativeContract(auth, h, ready)).toThrow('namespace_version_unsupported')
    expect(() => parseOpenWANativeContract(auth, health, { ...ready, raw: { engineLoaded: false } })).toThrow('namespace_session_not_live')
    expect(() => parseOpenWANativeContract(auth, health, { ...ready, raw: {} })).toThrow('namespace_session_not_live')
  })
  it('uses only authenticated bounded metadata probes, not a send or a session mutation', async () => {
    const request = vi.fn().mockImplementation(async (path: string) => path === '/api/auth/validate' ? auth : health)
    const client = { request } as unknown as OpenWAClient
    expect(await verifyOpenWANativeContract(client, ready, 'fixture')).toEqual(OPENWA_NATIVE_CONTRACT)
    expect(request.mock.calls).toEqual([
      ['/api/auth/validate', { method: 'POST', correlationId: 'fixture' }],
      ['/api/health', { correlationId: 'fixture' }],
    ])
    request.mockRejectedValueOnce(new Error('private data'))
    await expect(verifyOpenWANativeContract(client, ready, 'fixture')).rejects.toThrow('namespace_engine_unverified')
  })
})
