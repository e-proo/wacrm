import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveOpenWAClient } from '@/lib/whatsapp/transport/openwa/credentials'

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(), toErrorResponse: vi.fn(() => new Response('{}', { status: 403 })),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: vi.fn() }))
vi.mock('@/lib/whatsapp/transport/openwa/credentials', () => ({ resolveOpenWAClient: vi.fn() }))

import { POST } from './route'

const ACCOUNT = 'account-1'
const CONV = '11111111-1111-4111-8111-111111111111'
function chain(data: unknown) {
  const q: Record<string, unknown> = {}
  for (const k of ['select','eq','not','order','limit','is']) q[k] = vi.fn(() => q)
  q.maybeSingle = vi.fn(async () => ({ data, error: null }))
  return q
}
function request(id=CONV) {
  return new Request('https://localhost/api/whatsapp/openwa/read', {
    method:'POST',body:JSON.stringify({conversation_id:id}),
  })
}
describe('OpenWA chat read acknowledgements', () => {
  beforeEach(() => vi.clearAllMocks())
  it('rejects a cross-tenant conversation before ever reading privileged credentials', async () => {
    vi.mocked(requireRole).mockResolvedValue({ supabase: { from: vi.fn(() => chain(null)) } as never, accountId:ACCOUNT } as never)
    const response = await POST(request())
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'conversation_not_found' })
    expect(supabaseAdmin).not.toHaveBeenCalled()
  })
  it('does not fabricate a WhatsApp JID when no verified inbound identity exists', async () => {
    const from = vi.fn((table:string) => table==='conversations' ? chain({id:CONV}):chain(null))
    vi.mocked(requireRole).mockResolvedValue({supabase:{from} as never,accountId:ACCOUNT} as never)
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ providerMarked:false })
    expect(resolveOpenWAClient).not.toHaveBeenCalled()
  })
  it('sends a read request using only the signed inbound @lid on that account', async () => {
    const from = vi.fn((table:string) => table==='conversations' ? chain({id:CONV}) : chain({connection_id:'conn',provider_chat_id:'12345678901@lid'}))
    vi.mocked(requireRole).mockResolvedValue({supabase:{from} as never,accountId:ACCOUNT} as never)
    const adminFrom = vi.fn(() => chain({session_id:'session',status:'ready'}))
    vi.mocked(supabaseAdmin).mockReturnValue({from:adminFrom} as never)
    const markChatRead = vi.fn().mockResolvedValue(undefined)
    vi.mocked(resolveOpenWAClient).mockResolvedValue({client:{markChatRead} as never,credentials:{} as never})
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(markChatRead).toHaveBeenCalledWith('session','12345678901@lid')
    const inboundQuery = from.mock.results[1]?.value as {eq:ReturnType<typeof vi.fn>}
    expect(inboundQuery.eq).toHaveBeenCalledWith('conversation_id', CONV)
    expect(adminFrom).toHaveBeenCalledWith('whatsapp_connections')
    expect(resolveOpenWAClient).toHaveBeenCalledWith(expect.anything(),ACCOUNT,'conn')
  })
})
