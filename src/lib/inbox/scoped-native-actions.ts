import type {SupabaseClient} from '@supabase/supabase-js'
import {resolveOpenWAClient} from '@/lib/whatsapp/transport/openwa/credentials'
import {decrypt} from '@/lib/whatsapp/encryption'
import {sendReactionMessage,markMetaMessageRead} from '@/lib/whatsapp/meta-api'
import {evaluateInboxPolicy,ScopedInboxPolicyDenied} from './provider-policy'
import {beginInboxDispatch,completeNativeAction,getInboxNativeTarget} from './action-intents'
import {scopedInboxActionsEnabled} from './scoped-ui-gate'
import type {ScopedActionInput} from './scoped-action-input'

type NativeInput=Exclude<ScopedActionInput,{kind:'send'}>
type Actor={accountId:string;userId:string}
export async function runScopedNativeAction(db:SupabaseClient,caller:SupabaseClient,actor:Actor,input:NativeInput,intentId:string,recipient:string){
 const {scope,messageId}=input
 const read=input.kind==='provider_read'
 const initial=await getInboxNativeTarget(db,actor,scope,messageId,read)
 if(!initial)throw new ScopedInboxPolicyDenied()
 let invoke:()=>Promise<unknown>
 if(scope.provider==='openwa'){
  if(!read||!initial.chatId)throw new ScopedInboxPolicyDenied()
  const {data,error}=await db.from('whatsapp_connections').select('session_id').eq('account_id',actor.accountId).eq('id',scope.connectionId).eq('provider','openwa').is('archived_at',null).maybeSingle()
  if(error||!data?.session_id)throw new ScopedInboxPolicyDenied()
  const {client}=await resolveOpenWAClient(db,actor.accountId,scope.connectionId)
  const session=data.session_id as string,chat=initial.chatId
  invoke=()=>client.markChatRead(session,chat)
 }else{
  const {data:con,error:ce}=await caller.from('whatsapp_connections').select('provider_external_id').eq('id',scope.connectionId).eq('account_id',actor.accountId).eq('provider','meta_cloud').is('archived_at',null).maybeSingle()
  const {data:conf,error:err}=await caller.from('whatsapp_config').select('phone_number_id,access_token,status').eq('account_id',actor.accountId).maybeSingle()
  if(ce||err||!con?.provider_external_id||!conf||conf.status!=='connected'||con.provider_external_id!==conf.phone_number_id)throw new ScopedInboxPolicyDenied()
  const phoneNumberId=conf.phone_number_id as string,accessToken=decrypt(conf.access_token)
  invoke=read?()=>markMetaMessageRead({phoneNumberId,accessToken,messageId:initial.nativeId}):()=>sendReactionMessage({phoneNumberId,accessToken,to:recipient,targetMessageId:initial.nativeId,emoji:input.emoji})
 }
 // Re-resolve current proof and policy after credentials have been loaded;
 // mark the one irreversible attempt only when the frozen route still matches.
 if(!scopedInboxActionsEnabled())throw new ScopedInboxPolicyDenied()
 const latest=await evaluateInboxPolicy(db,{...actor,threadId:scope.threadId,channelId:scope.channelId,connectionId:scope.connectionId})
 const target=await getInboxNativeTarget(db,actor,scope,messageId,read)
 if(!latest||latest.context.membership_id!==scope.membershipId||latest.context.provider!==scope.provider||latest.context.recipient!==recipient||!(read?latest.capabilities.may_read:latest.capabilities.may_react)||!target||target.nativeId!==initial.nativeId||target.chatId!==initial.chatId)throw new ScopedInboxPolicyDenied()
 await beginInboxDispatch(db,actor,intentId,recipient)
 await invoke()
 await completeNativeAction(db,actor,intentId,messageId,read?null:input.emoji)
}
