import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { canonicalInboxTestMode, commitAndClaimCanonicalInbound, finishCanonicalDispatch } from './canonical-ingress'
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound-normalization'
const receipt = { eventId: 'evt', token: 'lease', sessionId: 's', instanceId: null }
const message: NormalizedInboundMessage = { id:'native', provider:'openwa', connectionId:'connection', providerMessageId:'native', providerMessageIdentityKind:'native', providerEventId:'evt', providerMetadata:{sessionId:'s'}, from:'123', timestamp:'1792950000', type:'text', text:{body:'hello'} }
const input = { accountId:'account', conversationId:'parent', message, receipt, contentType:'text', contentText:'hello', mediaType:null, contactCreated:true, conversationCreated:true }
const context = { firstInbound:true, contactCreated:true, conversationCreated:true, replyToMessageId:null }
const setup = (data: unknown, claim: unknown = 'claim') => {
  const rpc=vi.fn().mockResolvedValueOnce({data,error:null}).mockResolvedValueOnce({data:claim,error:null})
  return {rpc,db:{rpc} as unknown as SupabaseClient}
}
afterEach(()=>vi.unstubAllEnvs())
describe('canonical test admission',()=>{
  it('requires pinned TEST project and explicit test-only flag',()=>{
    vi.stubEnv('WACRM_INBOX_CANONICAL_INGRESS','test_only')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://example.supabase.co'); expect(canonicalInboxTestMode()).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://pqirsnfupofhulmewakq.supabase.co'); expect(canonicalInboxTestMode()).toBe(true)
    vi.stubEnv('WACRM_INBOX_CANONICAL_INGRESS','');expect(canonicalInboxTestMode()).toBe(false)
  })
  it.each([{state:'review'},{state:'duplicate',canClaim:false}])('never claims or dispatches duplicate/review',async data=>{
    const f=setup(data);expect(await commitAndClaimCanonicalInbound(f.db,input)).toBeNull();expect(f.rpc).toHaveBeenCalledTimes(1)
  })
  it('recovers only the original pending claim using persisted context',async()=>{
    const f=setup({state:'duplicate',canClaim:true,canonicalId:'canonical',messageId:'m',dispatchContext:context})
    const run=await commitAndClaimCanonicalInbound(f.db,{...input,contactCreated:false,conversationCreated:false})
    expect(run).toMatchObject({canonicalId:'canonical',messageId:'m',claim:'claim',contactCreated:true,conversationCreated:true,firstInbound:true})
    expect(f.rpc).toHaveBeenNthCalledWith(2,'inbox_claim_canonical_effect',expect.objectContaining({p_account:'account',p_connection:'connection',p_event:'evt',p_receipt_token:'lease'}))
    f.rpc.mockResolvedValueOnce({data:true,error:null})
    if (!run) throw new Error('fixture did not claim')
    await finishCanonicalDispatch(f.db,'account',run,true)
    expect(f.rpc).toHaveBeenLastCalledWith('inbox_finish_canonical_effect',{p_account:'account',p_canonical:'canonical',p_claim:'claim',p_returned:true})
  })
  it('does not process a changed receipt or a lost claim',async()=>{
    const f=setup({state:'inserted',canClaim:true,canonicalId:'canonical',messageId:'m',dispatchContext:context},null)
    await expect(commitAndClaimCanonicalInbound(f.db,{...input,receipt:{...receipt,eventId:'other'}})).rejects.toThrow('binding')
    expect(f.rpc).not.toHaveBeenCalled()
    expect(await commitAndClaimCanonicalInbound(f.db,input)).toBeNull()
  })
})
