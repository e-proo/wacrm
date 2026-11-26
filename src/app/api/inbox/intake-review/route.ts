import { NextResponse } from 'next/server'
import { requireRole,UnauthorizedError,ForbiddenError } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/openwa/environment'
import { checkRateLimit,rateLimitResponse } from '@/lib/rate-limit'
import { validId } from '@/lib/inbox/scoped-list-model'
import { normalizeReviewPage,normalizeReviewRow,REVIEW_ACTIONS } from '@/lib/inbox/intake-review-model'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0','Vary':'Cookie'}
const fail=(code:string,status:number)=>NextResponse.json({error:code},{status,headers})
function enabled(){return isOpenWATestProject()&&process.env.WACRM_INBOX_READ_API==='test_only'&&process.env.WACRM_INBOX_SCOPED_UI==='test_only'}
function maintenance(){return process.env.WACRM_INBOX_SHADOW_ENROLLMENT==='true'&&process.env.WACRM_INBOX_CANONICAL_INGRESS!=='test_only'&&process.env.WACRM_INBOX_ACTIONS!=='test_only'}
function matches(request:Request,ctx:{accountId:string;userId:string}){return request.headers.get('x-wacrm-inbox-account')===ctx.accountId&&request.headers.get('x-wacrm-inbox-actor')===ctx.userId}
function errorResponse(e:unknown){return e instanceof UnauthorizedError?fail('unauthorized',401):e instanceof ForbiddenError?fail('forbidden',403):fail('review_unavailable',503)}
export async function GET(request:Request){
 try{
  const ctx=await requireRole('admin')
  if(!enabled())return fail('review_disabled',403)
  if(!matches(request,ctx))return fail('context_changed',403)
  const q=new URL(request.url).searchParams
  if([...q.keys()].some(k=>!['after','closed'].includes(k)||q.getAll(k).length!==1))return fail('invalid_query',400)
  const after=q.get('after'),closed=q.get('closed')??'false'
  if(after!==null&&!validId(after)||!['true','false'].includes(closed))return fail('invalid_query',400)
  const limit=checkRateLimit('inbox-review-read:'+ctx.userId,{limit:30,windowMs:60000})
  if(!limit.success)return rateLimitResponse(limit)
  const {data,error}=await supabaseAdmin().rpc('inbox_admin_intake_review_page',{p_account:ctx.accountId,p_actor:ctx.userId,p_closed:closed==='true',p_after:after,p_limit:20})
  if(error?.code==='42501')return fail('forbidden',403)
  if(error||!data||!Array.isArray(data.rows)||data.rows.length>21)return fail('review_unavailable',503)
  const rows=data.rows.map(normalizeReviewRow)
  if(rows.some((r:unknown)=>r===null))return fail('review_unavailable',503)
  const items=rows.slice(0,20)
  const page=normalizeReviewPage({read_only:true,items,next_after:rows.length>20?items.at(-1)?.id:null,maintenance_ready:maintenance(),closed:closed==='true'})
  return page?NextResponse.json(page,{headers}):fail('review_unavailable',503)
 }catch(e){return errorResponse(e)}
}
export async function POST(request:Request){
 try{
  const ctx=await requireRole('admin')
  if(!enabled()||!maintenance())return fail('maintenance_required',403)
  if(!matches(request,ctx))return fail('context_changed',403)
  if(new URL(request.url).searchParams.size!==0)return fail('invalid_query',400)
  const limit=checkRateLimit('inbox-review-settle:'+ctx.userId,{limit:8,windowMs:60000})
  if(!limit.success)return rateLimitResponse(limit)
  const body:unknown=await request.json().catch(()=>null)
  if(!body||typeof body!=='object'||Array.isArray(body))return fail('invalid_action',400)
  const b=body as Record<string,unknown>
  if(Object.keys(b).some(k=>!['receiptId','action','requestId','confirmMaintenance'].includes(k))||
   !validId(b.receiptId)||!validId(b.requestId)||typeof b.action!=='string'||!(REVIEW_ACTIONS as readonly string[]).includes(b.action)||b.confirmMaintenance!==true)return fail('invalid_action',400)
  const {data,error}=await supabaseAdmin().rpc('inbox_admin_settle_intake_review',{p_account:ctx.accountId,p_actor:ctx.userId,p_receipt:b.receiptId,p_action:b.action,p_request:b.requestId})
  if(error?.code==='42501')return fail('forbidden',403)
  if(error?.code==='23505')return fail('review_conflict',409)
  if(error)return fail('review_unavailable',503)
  if(data?.state==='busy')return fail('review_busy',409)
  if(data?.state==='conflict'||data?.state==='not_eligible')return fail('review_conflict',409)
  const expected=b.action==='restore'?'restored_history':b.action==='duplicate'?'duplicate_confirmed':'closed_unverified'
  if(data?.state!=='settled'||data?.outcome!==expected)return fail('review_unavailable',503)
  return NextResponse.json({state:'settled',outcome:expected},{headers})
 }catch(e){return errorResponse(e)}
}
