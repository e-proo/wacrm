import { AsyncLocalStorage } from 'node:async_hooks'
import type { SupabaseClient } from '@supabase/supabase-js'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'
type CanonicalRoute = { accountId: string; conversationId: string; messageId: string; connectionId: string }
const routeScope = new AsyncLocalStorage<CanonicalRoute>()
export const withCanonicalRoute = <T>(route: CanonicalRoute, fn: () => Promise<T>): Promise<T> => routeScope.run(route, fn)
const unavailable = () => new WhatsAppTransportError('connection_restricted','The verified inbound WhatsApp route is no longer available')
export async function assertCanonicalRoute(db: SupabaseClient, accountId: string, connectionId: string) {
  const route = routeScope.getStore()
  if (!route || route.accountId !== accountId || route.connectionId !== connectionId) return
  const { data,error }=await db.rpc('inbox_validate_canonical_route',{p_account:accountId,p_conversation:route.conversationId,p_message:route.messageId,p_connection:connectionId})
  if(error||data!==true) throw unavailable()
}
export async function selectCanonicalRoute(db: SupabaseClient, accountId: string, conversationId: string, requested?: string|null): Promise<string|null|undefined> {
  const route=routeScope.getStore()
  if(!route||route.accountId!==accountId||route.conversationId!==conversationId) return requested
  if(requested&&requested!==route.connectionId) throw unavailable()
  await assertCanonicalRoute(db,accountId,route.connectionId)
  return route.connectionId
}
export async function getCanonicalAgentRunRoute(db: SupabaseClient, accountId: string, conversationId: string, runId: string, requested?: string|null): Promise<string|null|undefined> {
  const { data,error }=await db.rpc('inbox_canonical_agent_run_route',{p_account:accountId,p_conversation:conversationId,p_run:runId})
  if(error) throw unavailable()
  if(typeof data!=='string') return requested
  if(requested&&requested!==data) throw unavailable()
  return data
}

export async function withCanonicalAgentRunRoute<T>(db: SupabaseClient, accountId: string, conversationId: string, runId: string, requested: string|null|undefined, fn: () => Promise<T>): Promise<T> {
  const { data,error }=await db.rpc('inbox_canonical_agent_run_scope',{p_account:accountId,p_conversation:conversationId,p_run:runId})
  if(error) throw unavailable()
  if(data===null) return fn()
  if(!data||typeof data.messageId!=='string'||typeof data.connectionId!=='string'||(requested&&requested!==data.connectionId)) throw unavailable()
  return withCanonicalRoute({accountId,conversationId,messageId:data.messageId,connectionId:data.connectionId},fn)
}
