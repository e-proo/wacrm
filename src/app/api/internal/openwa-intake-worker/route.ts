import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/openwa/environment'
import { processOpenWAIntakeTick } from '@/lib/whatsapp/transport/openwa/intake-worker'
export const runtime='nodejs'
export const maxDuration=120
const headers={'Cache-Control':'private, no-store'}
export async function POST(request:Request){
 if(!isOpenWATestProject())return NextResponse.json({error:'TEST only'},{status:403,headers})
 const secret=process.env.CRON_SECRET
 if(!secret)return NextResponse.json({error:'Worker secret not configured'},{status:503,headers})
 const actual=Buffer.from(request.headers.get('authorization')??''),expected=Buffer.from('Bearer '+secret)
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return NextResponse.json({error:'Unauthorized'},{status:401,headers})
 try{return NextResponse.json(await processOpenWAIntakeTick(),{headers})}catch{
  console.warn('[openwa-intake-worker] tick failed (redacted)')
  return NextResponse.json({error:'Intake outcome unavailable'},{status:503,headers})
 }
}
