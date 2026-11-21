import { createHmac,timingSafeEqual } from 'node:crypto'

type Snapshot={accountId:string;userId:string;threadId:string;channelId:string;seen:string}
type SignedSnapshot=Snapshot & {exp:number}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const max='9223372036854775807'
export const validWatermark=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&(v.length<19||v<=max)
const validSnapshot=(x:Snapshot)=>[x.accountId,x.userId,x.threadId,x.channelId].every(v=>typeof v==='string'&&uuid.test(v))&&validWatermark(x.seen)
const signature=(key:string,body:string)=>createHmac('sha256',key).update('wacrm-inbox-read-snapshot-v1\0'+body).digest('base64url')
export function signReadSnapshot(snapshot:Snapshot,key:string,now=Date.now()):string {
 if(!key||!validSnapshot(snapshot))throw new Error('Invalid read snapshot')
 const body=Buffer.from(JSON.stringify({...snapshot,exp:now+120_000})).toString('base64url')
 return body+'.'+signature(key,body)
}
export function verifyReadSnapshot(value:unknown,expected:Pick<Snapshot,'accountId'|'userId'|'threadId'>,key:string,now=Date.now()):Snapshot|null {
 if(!key||typeof value!=='string'||value.length>1200)return null
 const parts=value.split('.')
 if(parts.length!==2||!parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)))return null
 const [body,mac]=parts,a=Buffer.from(mac),b=Buffer.from(signature(key,body))
 if(a.length!==b.length||!timingSafeEqual(a,b))return null
 try{
  const x=JSON.parse(Buffer.from(body,'base64url').toString('utf8')) as SignedSnapshot
  if(!x||!validSnapshot(x)||!Number.isSafeInteger(x.exp)||x.exp<=now||x.exp>now+120_000||
   x.accountId!==expected.accountId||x.userId!==expected.userId||x.threadId!==expected.threadId)return null
  return {accountId:x.accountId,userId:x.userId,threadId:x.threadId,channelId:x.channelId,seen:x.seen}
 }catch{return null}
}
