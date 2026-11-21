import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { selectCanonicalRoute, withCanonicalRoute, assertCanonicalRoute, getCanonicalAgentRunRoute, withCanonicalAgentRunRoute } from './canonical-route-context'
const route={accountId:'account',conversationId:'parent',messageId:'message',connectionId:'origin'}
const dbWith=(value:unknown,error:unknown=null)=>{const rpc=vi.fn().mockResolvedValue({data:value,error});return {rpc, db:{rpc} as unknown as SupabaseClient}}
describe('causal canonical route',()=>{
 it('pins only the matching account and CRM conversation, not a different business target',async()=>{
   const {rpc,db}=dbWith(true)
   await withCanonicalRoute(route,async()=>{
     expect(await selectCanonicalRoute(db,'account','parent')).toBe('origin')
     expect(await selectCanonicalRoute(db,'account','other','explicit')).toBe('explicit')
     expect(await selectCanonicalRoute(db,'other','parent','explicit')).toBe('explicit')
     await expect(selectCanonicalRoute(db,'account','parent','other')).rejects.toThrow(/verified inbound/)
   })
   expect(rpc).toHaveBeenCalledTimes(1)
   expect(await selectCanonicalRoute(db,'account','parent','legacy')).toBe('legacy')
 })
 it('does not fall back on unavailable or re-paired origin at the last dispatch boundary',async()=>{
   const {db}=dbWith(false)
   await withCanonicalRoute(route,async()=>{
     await expect(selectCanonicalRoute(db,'account','parent')).rejects.toThrow(/verified inbound/)
     await expect(assertCanonicalRoute(db,'account','origin')).rejects.toThrow(/verified inbound/)
   })
 })
 it('re-resolves queued agent causal identity without changing an explicit reservation',async()=>{
   const {db}=dbWith('origin')
   expect(await getCanonicalAgentRunRoute(db,'account','parent','run')).toBe('origin')
   await expect(getCanonicalAgentRunRoute(db,'account','parent','run','other')).rejects.toThrow(/verified inbound/)
   const old=dbWith(null)
   expect(await getCanonicalAgentRunRoute(old.db,'account','parent','run','explicit')).toBe('explicit')
 })
})

it('retains the queued run scope through guarded send and refuses a changed epoch or missing run',async()=>{
 const rpc=vi.fn().mockResolvedValueOnce({data:{messageId:'message',connectionId:'origin'},error:null}).mockResolvedValueOnce({data:false,error:null})
 const db={rpc} as unknown as SupabaseClient
 const send=vi.fn(async()=>assertCanonicalRoute(db,'account','origin'))
 await expect(withCanonicalAgentRunRoute(db,'account','parent','run',undefined,send)).rejects.toThrow(/verified inbound/)
 expect(send).toHaveBeenCalledTimes(1)
 expect(rpc).toHaveBeenLastCalledWith('inbox_validate_canonical_route',{p_account:'account',p_conversation:'parent',p_message:'message',p_connection:'origin'})
 const missing=dbWith(null,{code:'23514'})
 await expect(withCanonicalAgentRunRoute(missing.db,'account','parent','run',undefined,send)).rejects.toThrow(/verified inbound/)
 expect(send).toHaveBeenCalledTimes(1)
})
