import {NextResponse} from 'next/server'
import {requireRole,UnauthorizedError,ForbiddenError} from '@/lib/auth/account'
import {supabaseAdmin} from '@/lib/automations/admin-client'
import {checkRateLimit,rateLimitResponse} from '@/lib/rate-limit'
import {isOpenWATestProject} from '@/lib/whatsapp/transport/openwa/environment'
import {normalizeInboxHealth} from '@/lib/inbox/health-model'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0','Vary':'Cookie'}
function failure(code:string,status:number){return NextResponse.json({error:code},{status,headers})}
export async function GET(request:Request){
 try{
  const ctx=await requireRole('admin')
  // The observability endpoint is a TEST-only and server-side administrator
  // read. Neither a browser account header nor a query param may override it.
  if(!isOpenWATestProject()||process.env.WACRM_INBOX_READ_API!=='test_only')return failure('health_disabled',403)
  if(request.headers.get('x-wacrm-inbox-account')!==ctx.accountId||request.headers.get('x-wacrm-inbox-actor')!==ctx.userId)return failure('context_changed',403)
  if(new URL(request.url).searchParams.size!==0)return failure('invalid_query',400)
  const limit=checkRateLimit('inbox-health:'+ctx.userId,{limit:12,windowMs:60000})
  if(!limit.success)return rateLimitResponse(limit)
  const {data,error}=await supabaseAdmin().rpc('inbox_health_snapshot',{p_account:ctx.accountId,p_actor:ctx.userId})
  if(error||!data)return failure('health_unavailable',503)
  const report=normalizeInboxHealth(data)
  if(!report)return failure('health_unavailable',503)
  return NextResponse.json({read_only:true,...report},{headers})
 }catch(e){
  if(e instanceof UnauthorizedError)return failure('unauthorized',401)
  if(e instanceof ForbiddenError)return failure('forbidden',403)
  return failure('health_unavailable',503)
 }
}
