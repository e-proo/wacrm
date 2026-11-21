import { createHmac, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireRole, UnauthorizedError, ForbiddenError } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/openwa/environment'

type Op = 'channels'|'connections'|'threads'|'history'|'resolve'|'counts'|'observations'|'tags'
type Scope = 'active'|'historical'|'unknown'|'all'
type Input = { op: Op; scope: Scope; channel: string|null; parent: string|null; thread: string|null; message:string|null; connection: string|null; status: string|null; search: string|null; unread:boolean; assignment:string; tags:string[]; company:string|null; exact:string|null; limit: number }
type Anchor = { at: string|null; id: string }
type Row = { row_id: string; sort_at: string|null; payload: Record<string, unknown> }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const headers = { 'Cache-Control': 'private, no-store, max-age=0', 'Vary': 'Cookie' }
class InvalidRead extends Error {}
const bad = (): never => { throw new InvalidRead('Invalid inbox request or cursor') }
const checkId = (v: string|null) => v===null ? null : uuid.test(v) ? v.toLowerCase() : bad()
const hmac = (key: string, value: string) => createHmac('sha256',key).update('wacrm-inbox-read-v1\0'+value).digest('base64url')
export function parseInboxRead(request: Request, op: Op, ids: {thread?:string;parent?:string;message?:string} = {}): {input: Input; cursor: string|null} {
 const q=new URL(request.url).searchParams
 const allowed = new Set(['scope','limit','cursor',...(op==='channels'||op==='connections'||op==='threads'||op==='counts'||op==='history'||op==='observations'?['channel_id']:[]),...(op==='threads'||op==='counts'?['status','search','unread','assignment','tags','company']:[]),...(op==='resolve'?['connection_id']:[]),...(op==='threads'?['thread_id']:[])])
 for(const k of q.keys()) if(!allowed.has(k)||q.getAll(k).length!==1) bad()
 const scope=(q.get('scope')??(op==='resolve'?'all':ids.parent&&op==='history'?'unknown':op==='counts'||op==='tags'?'all':'active')) as Scope
 if(op==='tags'&&scope!=='all') bad()
 if(!['active','historical','unknown','all'].includes(scope)|| (scope==='all'&&!['resolve','counts','channels','connections','tags'].includes(op)) || (op==='resolve'&&scope!=='all' || scope==='unknown'&&['channels','observations'].includes(op)) || (op==='history'&&((scope==='unknown')!==Boolean(ids.parent)))) bad()
 const channel=checkId(q.get('channel_id')), parent=checkId(ids.parent??null), thread=checkId(ids.thread??null), message=checkId(ids.message??null), connection=checkId(q.get('connection_id'))
 if(scope==='unknown'&&channel || op==='history'&&!parent&&!thread || op==='resolve'&&!parent||op==='observations'&&(!thread||!message)) bad()
 const status=q.get('status'), search=q.get('search')?.trim()||null
 if(status!==null&&!['open','pending','closed'].includes(status)||search&&search.length>120) bad()
 const unread=q.get('unread')??'false', assignment=q.get('assignment')??'all', company=q.get('company')?.trim()||null
 const tags=q.get('tags')?.split(',').map(v=>checkId(v)!)??[]
 if(!['true','false'].includes(unread)||!['all','mine','unassigned'].includes(assignment)||tags.length>20||new Set(tags).size!==tags.length||company&&company.length>160)bad()
 tags.sort()
 const exact=checkId(q.get('thread_id'))
 const raw=q.get('limit')??(op==='history'?'50':'30')
 if(!/^\d{1,3}$/.test(raw)||Number(raw)<1||Number(raw)>100) bad()
 const cursor=q.get('cursor')
 if(cursor!==null&&(op==='counts'||cursor.length>1024||!cursor)) bad()
 return {input:{op,scope,channel,parent,thread,message,connection,status,search,unread:unread==='true',assignment,tags,company,exact,limit:Number(raw)},cursor}
}
function cursorScope(account:string, actor:string,input:Input) { return JSON.stringify([account,actor,input]) }
export function encodeInboxCursor(anchor: Anchor, account:string,actor:string,input:Input,key:string):string {
 const token=Buffer.from(JSON.stringify(anchor)).toString('base64url')
 return token+'.'+hmac(key,cursorScope(account,actor,input)+'\0'+token)
}
export function decodeInboxCursor(value:string|null,account:string,actor:string,input:Input,key:string): Anchor|null {
 if(value===null)return null
 const parts=value.split('.')
 if(parts.length!==2||!parts.every(x=>/^[A-Za-z0-9_-]+$/.test(x))) return bad()
 const [token,signature]=parts
 const want=hmac(key,cursorScope(account,actor,input)+'\0'+token)
 const a=Buffer.from(signature), b=Buffer.from(want)
 if(a.length!==b.length||!timingSafeEqual(a,b)) return bad()
 try{
  const x=JSON.parse(Buffer.from(token,'base64url').toString('utf8')) as Anchor
  if(!x||typeof x.id!=='string'||!uuid.test(x.id)||!(x.at===null||typeof x.at==='string'&&timestamp.test(x.at)&&Number.isFinite(Date.parse(x.at))))return bad()
  if(x.at===null&&['channels','connections','observations'].includes(input.op))return bad()
  return x
 }catch{return bad()}
}
export function safeInboxMedia(value:unknown,account:string,base=process.env.NEXT_PUBLIC_SUPABASE_URL):string|null{
 if(typeof value!=='string'||!base)return null
 try{
  const u=new URL(value), origin=new URL(base).origin
  const prefix='/storage/v1/object/public/'
  if(u.origin!==origin||u.username||u.password||u.search||u.hash||!['chat-media','flow-media'].some(b=>u.pathname.startsWith(prefix+b+'/account-'+account+'/'))||/%|\\/.test(u.pathname)||/\/\.\.?\//.test(value))return null
  return u.href
 }catch{return null}
}
export async function inboxRead(request:Request,op:Op,ids:{thread?:string;parent?:string;message?:string}={}){
 try{
  const ctx=await requireRole('viewer')
  // Optional expected context is a mismatch fence, not an account override.
  const expectedAccount=request.headers.get('x-wacrm-inbox-account'), expectedActor=request.headers.get('x-wacrm-inbox-actor')
  if((expectedAccount!==null||expectedActor!==null)&&(expectedAccount!==ctx.accountId||expectedActor!==ctx.userId)) return NextResponse.json({error:'Account context changed'},{status:403,headers})
  if(!isOpenWATestProject()||process.env.WACRM_INBOX_READ_API!=='test_only') return NextResponse.json({error:'Inbox read API disabled'},{status:403,headers})
  const {input,cursor}=parseInboxRead(request,op,ids)
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY
  if(!key)throw new Error('Server configuration')
  const anchor=decodeInboxCursor(cursor,ctx.accountId,ctx.userId,input,key)
  const filtered=['threads','counts','tags'].includes(op)
  const {data,error}=filtered ? await supabaseAdmin().rpc('inbox_read_filtered_page',{
   p_account:ctx.accountId,p_actor:ctx.userId,p_op:op,p_scope:input.scope,p_channel:input.channel,p_status:input.status,p_search:input.search,p_unread:input.unread,p_assignment:input.assignment,p_tags:input.tags,p_company:input.company,p_exact:input.exact,p_limit:input.limit,p_before_at:anchor?.at??null,p_before_id:anchor?.id??null
  }) : await supabaseAdmin().rpc('inbox_read_page',{
   p_account:ctx.accountId,p_actor:ctx.userId,p_op:input.op,p_scope:input.scope,p_channel:input.channel,p_parent:input.parent,p_thread:input.thread,p_connection:input.connection,p_status:input.status,p_search:input.search,p_limit:input.limit,p_before_at:anchor?.at??null,p_before_id:anchor?.id??null,p_message:input.message
  })
  if(error){if(error.code==='42501')return NextResponse.json({error:'Forbidden'},{status:403,headers});throw new Error('Inbox read unavailable')}
  if(data===null)return NextResponse.json({error:'Not found'},{status:404,headers})
  if(op==='counts')return NextResponse.json({counts:data.counts,read_only:true},{headers})
  if(!Array.isArray(data.rows)||data.rows.length>input.limit+1)throw new Error('Invalid read projection')
  const rows=(data.rows as Row[]).slice(0,input.limit)
  const last=rows.at(-1)
  const items=rows.map(({payload})=>op==='history'?{...payload,media_url:safeInboxMedia(payload.media_url,ctx.accountId)}:payload)
  return NextResponse.json({items,next_cursor:data.rows.length>input.limit&&last?encodeInboxCursor({at:last.sort_at,id:last.row_id},ctx.accountId,ctx.userId,input,key):null,read_only:true,...(op==='history'?{scope:data.scope,channel_id:data.channel_id,conversation_id:data.conversation_id,observed_highwater:data.observed_highwater,read_watermark:data.read_watermark}: {})},{headers})
 }catch(e){
  const status=e instanceof InvalidRead?400:e instanceof UnauthorizedError?401:e instanceof ForbiddenError?403:500
  return NextResponse.json({error:status===400?'Invalid inbox request or cursor':status===401?'Unauthorized':status===403?'Forbidden':'Inbox read unavailable'},{status,headers})
 }
}
