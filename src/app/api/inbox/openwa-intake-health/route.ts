import {NextResponse} from 'next/server'
import {requireRole,UnauthorizedError,ForbiddenError} from '@/lib/auth/account'
import {supabaseAdmin} from '@/lib/automations/admin-client'
import {isOpenWATestProject} from '@/lib/whatsapp/transport/openwa/environment'
import {durableOpenWAIntakeEnabled} from '@/lib/whatsapp/transport/openwa/durable-intake'
import {canonicalInboxTestMode} from '@/lib/inbox/canonical-ingress'
import {checkRateLimit,rateLimitResponse} from '@/lib/rate-limit'
import {validId} from '@/lib/inbox/scoped-list-model'
import {normalizeIntakeHealthPage,normalizeIntakeReviewRow} from '@/lib/inbox/openwa-intake-health-model'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0','Vary':'Cookie'}
const fail=(code:string,status:number)=>NextResponse.json({error:code},{status,headers})
function allowed(){return isOpenWATestProject()&&process.env.WACRM_INBOX_READ_API==='test_only'&&process.env.WACRM_INBOX_SCOPED_UI==='test_only'}
function maintenance(){return process.env.WACRM_INBOX_SHADOW_ENROLLMENT==='true'&&!durableOpenWAIntakeEnabled()&&!canonicalInboxTestMode()&&process.env.WACRM_INBOX_ACTIONS!=='test_only'}
function matches(request:Request,ctx:{accountId:string;userId:string}){return request.headers.get('x-wacrm-inbox-account')===ctx.accountId&&request.headers.get('x-wacrm-inbox-actor')===ctx.userId}
function errorResponse(e:unknown){return e instanceof UnauthorizedError?fail('unauthorized',401):e instanceof ForbiddenError?fail('forbidden',403):fail('intake_health_unavailable',503)}
export async function GET(request:Request){
 try{
  const ctx=await requireRole('admin')
  if(!allowed())return fail('health_disabled',403)
  if(!matches(request,ctx))return fail('context_changed',403)
  const q=new URL(request.url).searchParams
  if([...q.keys()].some(k=>k!=='after'||q.getAll(k).length!==1))return fail('invalid_query',400)
  const after=q.get('after')
  if(after!==null&&!validId(after))return fail('invalid_query',400)
  const limit=checkRateLimit('openwa-intake-health:'+ctx.userId,{limit:30,windowMs:60000})
  if(!limit.success)return rateLimitResponse(limit)
  const db=supabaseAdmin(),canonical=canonicalInboxTestMode()
  const [health,review]=await Promise.all([
   db.rpc('openwa_intake_health',{p_account:ctx.accountId,p_actor:ctx.userId,p_canonical:canonical}),
   db.rpc('openwa_intake_review_page',{p_account:ctx.accountId,p_actor:ctx.userId,p_after:after,p_limit:20})
  ])
  if(health.error?.code==='42501'||review.error?.code==='42501')return fail('forbidden',403)
  if(health.error||review.error||!review.data||!Array.isArray(review.data.rows)||review.data.rows.length>21)return fail('intake_health_unavailable',503)
  const rows=review.data.rows.map(normalizeIntakeReviewRow)
  if(rows.some((r:unknown)=>r===null))return fail('intake_health_unavailable',503)
  const items=rows.slice(0,20)
  const page=normalizeIntakeHealthPage({read_only:true,health:health.data,items,next_after:rows.length>20?items.at(-1)?.id:null,enabled:durableOpenWAIntakeEnabled(),canonical,maintenance_ready:maintenance()})
  return page?NextResponse.json(page,{headers}):fail('intake_health_unavailable',503)
 }catch(e){return errorResponse(e)}
}
export async function POST(request:Request){
 try{
  const ctx=await requireRole('admin')
  if(!allowed()||!maintenance())return fail('maintenance_required',403)
  if(!matches(request,ctx))return fail('context_changed',403)
  if(new URL(request.url).searchParams.size!==0)return fail('invalid_query',400)
  const limit=checkRateLimit('openwa-intake-close:'+ctx.userId,{limit:8,windowMs:60000})
  if(!limit.success)return rateLimitResponse(limit)
  const body:unknown=await request.json().catch(()=>null)
  if(!body||typeof body!=='object'||Array.isArray(body))return fail('invalid_action',400)
  const b=body as Record<string,unknown>
  if(Object.keys(b).some(k=>!['receiptId','confirmMaintenance'].includes(k))||!validId(b.receiptId)||b.confirmMaintenance!==true)return fail('invalid_action',400)
  const {data,error}=await supabaseAdmin().rpc('openwa_intake_close_unverified',{p_account:ctx.accountId,p_actor:ctx.userId,p_id:b.receiptId})
  if(error?.code==='42501')return fail('forbidden',403)
  if(error)return fail('intake_health_unavailable',503)
  if(data==='conflict')return fail('review_conflict',409)
  return data==='closed_unverified'?NextResponse.json({state:'closed_unverified'},{headers}):fail('intake_health_unavailable',503)
 }catch(e){return errorResponse(e)}
}
