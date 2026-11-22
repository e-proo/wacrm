import { NextResponse } from 'next/server'
import { requireRole,UnauthorizedError,ForbiddenError } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { evaluateInboxPolicy } from '@/lib/inbox/provider-policy'
import { scopedInboxEnabled,scopedInboxActionsEnabled } from '@/lib/inbox/scoped-ui-gate'
import { validId } from '@/lib/inbox/scoped-list-model'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0','Vary':'Cookie'}
const fail=(status:number,error:string)=>NextResponse.json({error},{status,headers})
export async function GET(request:Request,{params}:{params:Promise<{threadId:string}>}){
 try{
  const ctx=await requireRole('viewer')
  if(!scopedInboxEnabled())return fail(403,'Scoped inbox disabled')
  if(request.headers.get('x-wacrm-inbox-account')!==ctx.accountId||request.headers.get('x-wacrm-inbox-actor')!==ctx.userId)return fail(403,'Account context changed')
  const {threadId}=await params,q=new URL(request.url).searchParams
  const channel=q.get('channel_id'),connection=q.get('connection_id')
  if(!validId(threadId)||!validId(channel)||(connection!==null&&!validId(connection))||[...q.keys()].some(k=>!['channel_id','connection_id'].includes(k)||q.getAll(k).length!==1))return fail(400,'Invalid policy request')
  const result=await evaluateInboxPolicy(supabaseAdmin(),{accountId:ctx.accountId,userId:ctx.userId,threadId:threadId.toLowerCase(),channelId:channel.toLowerCase(),connectionId:connection?.toLowerCase()??null})
  if(!result)return fail(404,'Policy context not found')
  return NextResponse.json({capabilities:{...result.capabilities,dispatch_enabled:scopedInboxActionsEnabled()&&result.context.can_operate,membership_id:result.context.membership_id},read_only:true},{headers})
 }catch(e){return e instanceof UnauthorizedError?fail(401,'Unauthorized'):e instanceof ForbiddenError?fail(403,'Forbidden'):fail(503,'Policy unavailable')}
}
