import {NextResponse} from 'next/server'
import {randomUUID} from 'node:crypto'
import {requireRole,UnauthorizedError,ForbiddenError} from '@/lib/auth/account'
import {supabaseAdmin} from '@/lib/automations/admin-client'
import {evaluateInboxPolicy} from '@/lib/inbox/provider-policy'
import {scopedInboxActionsEnabled} from '@/lib/inbox/scoped-ui-gate'
import {validId} from '@/lib/inbox/scoped-list-model'
import {validVideoSize,hasVideoContainer,VIDEO_LIMIT} from '@/lib/inbox/scoped-video-upload'
import {checkRateLimit,rateLimitResponse,RATE_LIMITS} from '@/lib/rate-limit'
import {safeInboxMedia} from '@/lib/inbox/read-api'

export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0','Vary':'Cookie'}
const fail=(status:number)=>NextResponse.json({error:'video_upload_failed'},{status,headers})
export async function POST(request:Request,{params}:{params:Promise<{threadId:string}>}){
 try{
  const ctx=await requireRole('agent')
  if(!scopedInboxActionsEnabled()||request.headers.get('x-wacrm-inbox-account')!==ctx.accountId||request.headers.get('x-wacrm-inbox-actor')!==ctx.userId)return fail(403)
  const origin=request.headers.get('origin')
  if(request.headers.get('sec-fetch-site')==='cross-site'||origin!==null&&origin!==new URL(request.url).origin)return fail(403)
  const {threadId}=await params,q=new URL(request.url).searchParams,channelId=q.get('channel_id'),connectionId=q.get('connection_id')
  if(![threadId,channelId,connectionId].every(validId)||[...q.keys()].some(k=>!['channel_id','connection_id'].includes(k)||q.getAll(k).length!==1))return fail(400)
  const mime=request.headers.get('content-type')
  if(mime!=='video/mp4'&&mime!=='video/3gpp')return fail(415)
  const size=Number(request.headers.get('x-wacrm-upload-size')),length=request.headers.get('content-length')
  if(!validVideoSize(size)||length!==null&&Number(length)!==size)return fail(413)
  const limit=checkRateLimit('inbox-video:'+ctx.userId,RATE_LIMITS.send)
  if(!limit.success)return rateLimitResponse(limit)
  const policy=await evaluateInboxPolicy(supabaseAdmin(),{accountId:ctx.accountId,userId:ctx.userId,threadId,channelId:channelId!,connectionId:connectionId!})
  if(!policy?.context.can_operate||!policy.capabilities.may_send_media||!policy.capabilities.media_kinds.includes('video'))return fail(409)
  if(!request.body)return fail(400)
  const reader=request.body.getReader(),buffer=new ArrayBuffer(size),bytes=new Uint8Array(buffer)
  let offset=0
  try{
   for(;;){
    const {done,value}=await reader.read()
    if(done)break
    if(offset+value.length>size||offset+value.length>VIDEO_LIMIT){await reader.cancel();return fail(413)}
    bytes.set(value,offset);offset+=value.length
   }
  }finally{reader.releaseLock()}
  if(offset!==size)return fail(400)
  if(!hasVideoContainer(bytes))return fail(415)
  const path='account-'+ctx.accountId+'/'+Date.now()+'-'+randomUUID()+'.'+(mime==='video/mp4'?'mp4':'3gp')
  // User's authenticated storage client, unchanged bucket/RLS. No service
  // role upload, no provider send, no automatic retry after uncertain upload.
  const storage=ctx.supabase.storage.from('chat-media')
  const {error}=await storage.upload(path,buffer,{contentType:mime,upsert:false,cacheControl:'3600'})
  if(error)return fail(502)
  const {data:{publicUrl}}=storage.getPublicUrl(path)
  if(!safeInboxMedia(publicUrl,ctx.accountId))return fail(502)
  return NextResponse.json({path,publicUrl},{headers})
 }catch(e){return fail(e instanceof UnauthorizedError?401:e instanceof ForbiddenError?403:503)}
}
