import { NextResponse } from 'next/server'
import { requireRole,UnauthorizedError,ForbiddenError } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { scopedInboxEnabled } from './scoped-ui-gate'
import { verifyReadSnapshot } from './read-snapshot'
import { validId } from './scoped-list-model'

const headers={'Cache-Control':'private, no-store, max-age=0','Vary':'Cookie'}
const fail=(status:number,error:string)=>NextResponse.json({error},{status,headers})
// A local CRM acknowledgement only. No provider calls, legacy unread resets,
// notification clearing or outbound side effects. A signed visible snapshot
// limits the requested highwater; SQL repeats role, account and channel checks.
export async function acknowledgeScopedThread(request:Request,threadId:string) {
 try{
  const ctx=await requireRole('agent')
  if(!scopedInboxEnabled())return fail(403,'Scoped inbox disabled')
  if(request.headers.get('x-wacrm-inbox-account')!==ctx.accountId||request.headers.get('x-wacrm-inbox-actor')!==ctx.userId)return fail(403,'Account context changed')
  const origin=request.headers.get('origin')
  if(request.headers.get('sec-fetch-site')==='cross-site'||(origin!==null&&origin!==new URL(request.url).origin))return fail(403,'Forbidden origin')
  if(!validId(threadId)||request.headers.get('content-type')?.split(';')[0]!=='application/json'||Number(request.headers.get('content-length')??0)>2048)return fail(400,'Invalid read acknowledgement')
  const raw=await request.text()
  if(raw.length>2048)return fail(400,'Invalid read acknowledgement')
  let token:unknown
  try{const body=JSON.parse(raw);if(!body||Object.keys(body).length!==1||!Object.hasOwn(body,'token'))return fail(400,'Invalid read acknowledgement');token=body.token}catch{return fail(400,'Invalid read acknowledgement')}
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY
  if(!key)throw new Error('Server configuration')
  const snapshot=verifyReadSnapshot(token,{accountId:ctx.accountId,userId:ctx.userId,threadId:threadId.toLowerCase()},key)
  if(!snapshot)return fail(400,'Invalid or expired read snapshot')
  const {data,error}=await supabaseAdmin().rpc('inbox_mark_thread_read',{p_account:ctx.accountId,p_actor:ctx.userId,p_thread:snapshot.threadId,p_channel:snapshot.channelId,p_seen:snapshot.seen})
  if(error){if(error.code==='42501')return fail(403,'Forbidden');if(error.code==='22023')return fail(409,'Read snapshot changed');throw new Error('Read unavailable')}
  if(!data)return fail(404,'Thread not available in active channel')
  return NextResponse.json(data,{headers})
 }catch(e){return e instanceof UnauthorizedError?fail(401,'Unauthorized'):e instanceof ForbiddenError?fail(403,'Forbidden'):fail(500,'Read unavailable')}
}
