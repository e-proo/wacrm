import type {SupabaseClient} from '@supabase/supabase-js'
import {actionFingerprint,decodeIntent,type ActionScope} from './action-intent-model'
import {validId} from './scoped-list-model'
type Actor={accountId:string;userId:string}
type Kind='send'|'provider_read'|'reaction'
export async function claimInboxAction(db:SupabaseClient,actor:Actor,scope:ActionScope,key:string,kind:Kind,recipient:string,payload:unknown){
 if(!validId(key))throw Error('Invalid action key')
 const {data,error}=await db.rpc('inbox_claim_action',{p_account:actor.accountId,p_actor:actor.userId,p_key:key,p_thread:scope.threadId,p_channel:scope.channelId,p_connection:scope.connectionId,p_membership:scope.membershipId,p_provider:scope.provider,p_kind:kind,p_fingerprint:actionFingerprint(scope,kind,recipient,payload)})
 if(error)throw Error('Action admission unavailable')
 return decodeIntent(data)
}
export async function finishInboxAction(db:SupabaseClient,actor:Actor,intentId:string,state:'accepted'|'blocked'|'uncertain',messageId?:string){
 const {data,error}=await db.from('inbox_action_intents').update({state,message_id:messageId??null,finished_at:new Date().toISOString()}).eq('id',intentId).eq('account_id',actor.accountId).eq('actor_id',actor.userId).eq('state','pending').select('id').maybeSingle()
 if(error||!data)throw Error('Action outcome unconfirmed')
}
export async function getInboxNativeTarget(db:SupabaseClient,actor:Actor,scope:ActionScope,messageId:string,read=false){
 if(!validId(messageId))return null
 const {data,error}=await db.rpc('inbox_native_action_target',{p_account:actor.accountId,p_actor:actor.userId,p_thread:scope.threadId,p_channel:scope.channelId,p_connection:scope.connectionId,p_membership:scope.membershipId,p_message:messageId,p_read:read})
 if(error)throw Error('Native route unavailable')
 if(!data||data.provider!==scope.provider||typeof data.native_id!=='string'||!data.native_id.trim()||data.native_id.length>512)return null
 if(scope.provider==='openwa'&&(typeof data.chat_id!=='string'||!/^[0-9]{5,20}@(c\.us|lid)$/.test(data.chat_id)))return null
 return {nativeId:data.native_id as string,chatId:typeof data.chat_id==='string'?data.chat_id:null}
}
