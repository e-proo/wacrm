import {NextResponse} from 'next/server'
import {requireRole,UnauthorizedError,ForbiddenError} from '@/lib/auth/account'
import {supabaseAdmin} from '@/lib/automations/admin-client'
import {checkRateLimit,rateLimitResponse,RATE_LIMITS} from '@/lib/rate-limit'
import {sendMessageToConversation} from '@/lib/whatsapp/send-message'
import {allowsContent} from './provider-policy-model'
import {evaluateInboxPolicy} from './provider-policy'
import {claimInboxAction,failInboxAction} from './action-intents'
import {parseScopedAction,type ScopedActionInput} from './scoped-action-input'
import {runScopedNativeAction} from './scoped-native-actions'
import {scopedInboxActionsEnabled,scopedInboxEnabled} from './scoped-ui-gate'
import {validId} from './scoped-list-model'
const headers={'Cache-Control':'private, no-store, max-age=0','Vary':'Cookie'}
const reply=(data:object,status=200)=>NextResponse.json(data,{status,headers})
const fail=(status:number,code:string)=>reply({state:'denied',code},status)
export async function performScopedAction(request:Request,threadId:string){
 try{
  const ctx=await requireRole('agent')
  if(!scopedInboxActionsEnabled())return fail(403,'actions_disabled')
  if(request.headers.get('x-wacrm-inbox-account')!==ctx.accountId||request.headers.get('x-wacrm-inbox-actor')!==ctx.userId)return fail(403,'context_changed')
  const origin=request.headers.get('origin')
  if(request.headers.get('sec-fetch-site')==='cross-site'||origin!==null&&origin!==new URL(request.url).origin)return fail(403,'forbidden_origin')
  if(!validId(threadId)||request.headers.get('content-type')?.split(';')[0]!=='application/json'||Number(request.headers.get('content-length')??0)>32768)return fail(400,'invalid_action')
  const raw=await request.text()
  if(raw.length>32768)return fail(400,'invalid_action')
  let input:ScopedActionInput
  try{input=parseScopedAction(JSON.parse(raw),threadId,ctx.accountId)}catch{return fail(400,'invalid_action')}
  const limit=checkRateLimit('send:'+ctx.userId,RATE_LIMITS.send)
  if(!limit.success)return rateLimitResponse(limit)
  const db=supabaseAdmin(),actor={accountId:ctx.accountId,userId:ctx.userId},s=input.scope
  const policy=await evaluateInboxPolicy(db,{...actor,threadId:s.threadId,channelId:s.channelId,connectionId:s.connectionId})
  if(!policy||policy.context.membership_id!==s.membershipId||policy.context.provider!==s.provider||!policy.context.recipient)return fail(409,'scope_changed')
  const recipient=policy.context.recipient
  const payload=input.kind==='send'?{...input.params,conversationId:policy.context.conversation_id}:input.kind==='reaction'?{messageId:input.messageId,emoji:input.emoji}:{messageId:input.messageId}
  // Existing keys are resolved by the journal, never create a second provider request.
  if(input.kind==='send'?(!allowsContent(policy.capabilities,input.params.messageType)||Boolean(input.params.replyToMessageId)&&!policy.capabilities.may_reply):input.kind==='reaction'?!policy.capabilities.may_react:!policy.capabilities.may_read)return fail(409,'policy_denied')
  const intent=await claimInboxAction(db,actor,s,input.key,input.kind,recipient,payload).catch(()=>null)
  if(!intent)return reply({state:'uncertain',code:'admission_unconfirmed'},503)
  if(intent.state==='conflict'||intent.state==='denied')return fail(409,intent.state==='conflict'?'idempotency_conflict':'scope_changed')
  if(intent.state!=='claimed')return reply({state:intent.state,intent_id:intent.intent_id,message_id:intent.message_id??null,replayed:true},intent.state==='accepted'?200:409)
  const id=intent.intent_id!
  try{
   if(input.kind==='send'){
    const result=await sendMessageToConversation(ctx.supabase,ctx.accountId,{...input.params,conversationId:policy.context.conversation_id,connectionId:s.connectionId,idempotencyKey:'inbox-action:'+id,workload:'manual',senderType:'agent',scopedInbox:{userId:ctx.userId,threadId:s.threadId,channelId:s.channelId,membershipId:s.membershipId,intentId:id,provider:s.provider,recipient}})
    return reply({state:'accepted',intent_id:id,message_id:result.messageId,replayed:false})
   }
   await runScopedNativeAction(db,ctx.supabase,actor,input,id,recipient)
   return reply({state:'accepted',intent_id:id,replayed:false})
  }catch{
   let state:'accepted'|'blocked'|'uncertain'='uncertain'
   try{state=await failInboxAction(db,actor,id)}catch{/* An unconfirmed outcome must never be reported as retryable. */}
   return reply({state,intent_id:id,code:state==='blocked'?'pre_dispatch_denied':state==='uncertain'?'reconciliation_required':'accepted'},state==='accepted'?200:409)
  }
 }catch(e){return e instanceof UnauthorizedError?fail(401,'unauthorized'):e instanceof ForbiddenError?fail(403,'forbidden'):fail(503,'action_unavailable')}
}

export async function getScopedAction(request:Request,threadId:string){
 try{
  const ctx=await requireRole('agent')
  if(!scopedInboxEnabled()||request.headers.get('x-wacrm-inbox-account')!==ctx.accountId||request.headers.get('x-wacrm-inbox-actor')!==ctx.userId)return fail(403,'context_changed')
  const q=new URL(request.url).searchParams,key=q.get('key')
  if(!validId(threadId)||!validId(key)||[...q.keys()].some(k=>k!=='key'||q.getAll(k).length!==1))return fail(400,'invalid_action')
  const {data,error}=await supabaseAdmin().from('inbox_action_intents').select('id,state,message_id').eq('account_id',ctx.accountId).eq('actor_id',ctx.userId).eq('thread_id',threadId).eq('request_key',key).maybeSingle()
  if(error)return fail(503,'action_unavailable')
  if(!data)return reply({state:'unconfirmed'},404)
  return reply({state:data.state,intent_id:data.id,message_id:data.message_id})
 }catch(e){return e instanceof UnauthorizedError?fail(401,'unauthorized'):e instanceof ForbiddenError?fail(403,'forbidden'):fail(503,'action_unavailable')}
}

export async function openScopedThread(request:Request){
 try{
  const ctx=await requireRole('agent')
  if(!scopedInboxActionsEnabled()||request.headers.get('x-wacrm-inbox-account')!==ctx.accountId||request.headers.get('x-wacrm-inbox-actor')!==ctx.userId)return fail(403,'context_changed')
  const origin=request.headers.get('origin')
  if(request.headers.get('sec-fetch-site')==='cross-site'||origin!==null&&origin!==new URL(request.url).origin)return fail(403,'forbidden_origin')
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json'||Number(request.headers.get('content-length')??0)>4096)return fail(400,'invalid_action')
  const raw=await request.text()
  if(raw.length>4096)return fail(400,'invalid_action')
  let p:Record<string,unknown>
  try{p=JSON.parse(raw)}catch{return fail(400,'invalid_action')}
  if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==4||![p.contactId,p.channelId,p.connectionId].every(validId)||(p.provider!=='meta_cloud'&&p.provider!=='openwa'))return fail(400,'invalid_action')
  const limit=checkRateLimit('send:'+ctx.userId,RATE_LIMITS.send)
  if(!limit.success)return rateLimitResponse(limit)
  // The browser selects a specific verified session, never an epoch UUID.
  // Bind the current membership on the server and let the SQL RPC recheck
  // its active state transactionally; there is no implicit primary fallback.
  const db=supabaseAdmin()
  const {data:epoch,error:epochError}=await db.from('whatsapp_channel_memberships').select('id')
   .eq('account_id',ctx.accountId).eq('channel_id',p.channelId).eq('connection_id',p.connectionId)
   .eq('provider',p.provider).is('valid_until',null).maybeSingle()
  if(epochError||!validId(epoch?.id))return fail(409,'scope_changed')
  const {data,error}=await db.rpc('inbox_open_explicit_thread',{p_account:ctx.accountId,p_actor:ctx.userId,p_contact:p.contactId,p_channel:p.channelId,p_connection:p.connectionId,p_membership:epoch.id,p_provider:p.provider})
  if(error||!validId(data))return fail(409,'scope_changed')
  return reply({thread_id:data,channel_id:p.channelId})
 }catch(e){return e instanceof UnauthorizedError?fail(401,'unauthorized'):e instanceof ForbiddenError?fail(403,'forbidden'):fail(503,'action_unavailable')}
}
