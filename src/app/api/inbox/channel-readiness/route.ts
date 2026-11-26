import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireRole,UnauthorizedError,ForbiddenError } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/openwa/environment'
import { checkRateLimit,rateLimitResponse } from '@/lib/rate-limit'
import { validId } from '@/lib/inbox/scoped-list-model'
import { normalizeReadinessPage,normalizeReadinessRow,type ReadinessGates } from '@/lib/inbox/channel-readiness-model'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0','Vary':'Cookie'}
const fail=(code:string,status:number)=>NextResponse.json({error:code},{status,headers})
function gates():ReadinessGates{return {shadow:process.env.WACRM_INBOX_SHADOW_ENROLLMENT==='true',
 canonical:process.env.WACRM_INBOX_CANONICAL_INGRESS==='test_only',actions:process.env.WACRM_INBOX_ACTIONS==='test_only'}}
function enabled(){return isOpenWATestProject()&&process.env.WACRM_INBOX_READ_API==='test_only'&&process.env.WACRM_INBOX_SCOPED_UI==='test_only'}
function matches(request:Request,ctx:{accountId:string;userId:string}){return request.headers.get('x-wacrm-inbox-account')===ctx.accountId&&request.headers.get('x-wacrm-inbox-actor')===ctx.userId}
function errorResponse(e:unknown){return e instanceof UnauthorizedError?fail('unauthorized',401):e instanceof ForbiddenError?fail('forbidden',403):fail('readiness_unavailable',503)}
export async function GET(request:Request){
 try{
  const ctx=await requireRole('admin')
  if(!enabled())return fail('readiness_disabled',403)
  if(!matches(request,ctx))return fail('context_changed',403)
  const q=new URL(request.url).searchParams
  if([...q.keys()].some(k=>k!=='after'||q.getAll(k).length!==1))return fail('invalid_query',400)
  const after=q.get('after')
  if(after!==null&&!validId(after))return fail('invalid_query',400)
  const limit=checkRateLimit('inbox-readiness:'+ctx.userId,{limit:30,windowMs:60000})
  if(!limit.success)return rateLimitResponse(limit)
  const {data,error}=await supabaseAdmin().rpc('inbox_admin_channel_readiness',{p_account:ctx.accountId,p_actor:ctx.userId,p_after:after,p_limit:20})
  if(error?.code==='42501')return fail('forbidden',403)
  if(error||!data||!Array.isArray(data.rows)||data.rows.length>21)return fail('readiness_unavailable',503)
  const rows=data.rows.map(normalizeReadinessRow)
  if(rows.some((r:unknown)=>r===null))return fail('readiness_unavailable',503)
  const items=rows.slice(0,20)
  const page=normalizeReadinessPage({read_only:true,items,next_after:rows.length>20?items.at(-1)?.id:null,gates:gates()})
  return page?NextResponse.json(page,{headers}):fail('readiness_unavailable',503)
 }catch(e){return errorResponse(e)}
}
// Revocation is NOT a stop/logout/send-policy operation. The operator must
// explicitly confirm maintenance; the DB locks and validates the expected epoch.
export async function POST(request:Request){
 try{
  const ctx=await requireRole('admin')
  const g=gates()
  if(!enabled()||!g.shadow||g.canonical||g.actions)return fail('maintenance_required',403)
  if(!matches(request,ctx))return fail('context_changed',403)
  if(new URL(request.url).searchParams.size!==0)return fail('invalid_query',400)
  const limit=checkRateLimit('inbox-readiness-revoke:'+ctx.userId,{limit:8,windowMs:60000})
  if(!limit.success)return rateLimitResponse(limit)
  const body:unknown=await request.json().catch(()=>null)
  if(!body||typeof body!=='object'||Array.isArray(body))return fail('invalid_revocation',400)
  const b=body as Record<string,unknown>
  if(Object.keys(b).some(k=>!['connectionId','membershipId','wasPrimary','confirmMaintenance'].includes(k))||
   !validId(b.connectionId)||!validId(b.membershipId)||typeof b.wasPrimary!=='boolean'||b.confirmMaintenance!==true)return fail('invalid_revocation',400)
  const {data,error}=await supabaseAdmin().rpc('inbox_admin_revoke_openwa_enrollment',{
   p_account:ctx.accountId,p_actor:ctx.userId,p_connection:b.connectionId,p_membership:b.membershipId,p_was_primary:b.wasPrimary,p_request:randomUUID()})
  if(error?.code==='42501')return fail('forbidden',403)
  if(error)return fail('readiness_unavailable',503)
  if(data?.state==='busy')return fail('revocation_busy',409)
  if(data?.state==='conflict')return fail('revocation_conflict',409)
  if(data?.state!=='revoked')return fail('readiness_unavailable',503)
  return NextResponse.json({state:'revoked'},{headers})
 }catch(e){return errorResponse(e)}
}
