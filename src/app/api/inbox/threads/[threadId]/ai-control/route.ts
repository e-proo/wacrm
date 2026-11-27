import {NextResponse} from 'next/server'
import {requireRole,UnauthorizedError,ForbiddenError} from '@/lib/auth/account'
import {supabaseAdmin} from '@/lib/automations/admin-client'
import {loadPolicyContext} from '@/lib/inbox/provider-policy'
import {scopedInboxEnabled,scopedInboxActionsEnabled} from '@/lib/inbox/scoped-ui-gate'
import {validId} from '@/lib/inbox/scoped-list-model'
import {aiConversationPatch} from '@/lib/ai/conversation-control'
import {checkRateLimit,rateLimitResponse,RATE_LIMITS} from '@/lib/rate-limit'

export const dynamic='force-dynamic'
type Params={params:Promise<{threadId:string}>}
const headers={'Cache-Control':'private, no-store, max-age=0','Vary':'Cookie'}
const reply=(body:object,status=200)=>NextResponse.json(body,{status,headers})
async function control(request:Request,{params}:Params,write:boolean){
 try{
  const ctx=await requireRole(write?'agent':'viewer')
  if(!scopedInboxEnabled()||write&&!scopedInboxActionsEnabled()||request.headers.get('x-wacrm-inbox-account')!==ctx.accountId||request.headers.get('x-wacrm-inbox-actor')!==ctx.userId)return reply({error:'context_changed'},403)
  const {threadId}=await params,q=new URL(request.url).searchParams,channelId=q.get('channel_id')
  if(!validId(threadId)||!validId(channelId)||[...q.keys()].some(k=>k!=='channel_id'||q.getAll(k).length!==1))return reply({error:'invalid_scope'},400)
  const origin=request.headers.get('origin')
  if(write&&(request.headers.get('sec-fetch-site')==='cross-site'||origin!==null&&origin!==new URL(request.url).origin))return reply({error:'forbidden_origin'},403)
  let input:{paused:boolean;expectedPaused:boolean;expectedHuman:boolean}|null=null
  if(write){
   if(request.headers.get('content-type')?.split(';')[0]!=='application/json'||Number(request.headers.get('content-length')??0)>2048)return reply({error:'invalid_action'},400)
   const raw=await request.text()
   if(raw.length>2048)return reply({error:'invalid_action'},400)
   const body=JSON.parse(raw)
   if(!body||Object.keys(body).length!==3||typeof body.paused!=='boolean'||typeof body.expectedPaused!=='boolean'||typeof body.expectedHuman!=='boolean')return reply({error:'invalid_action'},400)
   input=body
   const limit=checkRateLimit('ai-takeover:'+ctx.userId,RATE_LIMITS.send)
   if(!limit.success)return rateLimitResponse(limit)
  }
  // Existing policy RPC proves the account/thread/channel relationship.
  // Never use a client-supplied conversation ID or select a sending route.
  const db=supabaseAdmin(),scope=await loadPolicyContext(db,{accountId:ctx.accountId,userId:ctx.userId,threadId,channelId,connectionId:null})
  if(!scope||!scope.membership_id)return reply({error:'scope_changed'},404)
  const [{data:conv,error:convErr},{data:config,error:configErr},{count,error:countErr}]=await Promise.all([
   ctx.supabase.from('conversations').select('id,ai_autoreply_disabled,assigned_agent_id,ai_handoff_summary,ai_reply_count').eq('id',scope.conversation_id).eq('account_id',ctx.accountId).maybeSingle(),
   ctx.supabase.from('ai_configs').select('is_active,auto_reply_enabled,auto_reply_max_per_conversation').eq('account_id',ctx.accountId).maybeSingle(),
   db.from('inbox_threads').select('id',{head:true,count:'exact'}).eq('account_id',ctx.accountId).eq('conversation_id',scope.conversation_id)
  ])
  if(convErr||configErr||countErr||count===null)return reply({error:'unavailable'},503)
  if(!conv)return reply({error:'scope_changed'},404)
  const enabled=Boolean(config?.is_active&&config?.auto_reply_enabled)
  const canChange=scope.can_operate&&scopedInboxActionsEnabled()
  // AI ownership remains CRM-parent-wide. Do not resume a multi-lane
  // parent until the bot has an explicit per-channel execution contract.
  const canResume=canChange&&count===1
  if(!input)return reply({read_only:true,thread_id:threadId,channel_id:channelId,enabled,paused:conv.ai_autoreply_disabled===true,human_assigned:Boolean(conv.assigned_agent_id),handoff_summary:conv.ai_handoff_summary??null,cap_reached:conv.ai_reply_count>=(config?.auto_reply_max_per_conversation??0),can_change:canChange,can_resume:canResume})
  if(!enabled||!canChange||!input.paused&&!canResume)return reply({error:'control_denied'},409)
  if(input.expectedPaused!==(conv.ai_autoreply_disabled===true)||input.expectedHuman!==Boolean(conv.assigned_agent_id))return reply({error:'state_changed'},409)
  // Compare the exact assignee, pause and counter snapshot so a competing
  // handoff or bot slot claim cannot silently be overwritten.
  let update=ctx.supabase.from('conversations').update(aiConversationPatch(input.paused,ctx.userId)).eq('account_id',ctx.accountId).eq('id',scope.conversation_id).eq('ai_autoreply_disabled',conv.ai_autoreply_disabled).eq('ai_reply_count',conv.ai_reply_count)
  update=conv.assigned_agent_id?update.eq('assigned_agent_id',conv.assigned_agent_id):update.is('assigned_agent_id',null)
  const {data,error}=await update.select('id').maybeSingle()
  if(error)return reply({error:'unavailable'},503)
  if(!data)return reply({error:'state_changed'},409)
  return reply({success:true,thread_id:threadId,channel_id:channelId})
 }catch(e){return reply({error:'control_unavailable'},e instanceof UnauthorizedError?401:e instanceof ForbiddenError?403:e instanceof SyntaxError?400:503)}
}
export function GET(request:Request,params:Params){return control(request,params,false)}
export function POST(request:Request,params:Params){return control(request,params,true)}
