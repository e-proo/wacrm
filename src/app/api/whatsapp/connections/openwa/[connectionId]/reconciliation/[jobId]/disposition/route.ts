/** TEST-only, authenticated, auditable non-delivery ACK disposition.
 * Does NOT mutate WhatsApp messages, resend, or manufacture provider results.
 */
import { NextResponse } from 'next/server'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { requireOpenWASessionAdmin } from '@/lib/whatsapp/transport/openwa/session-auth'
import { inspectOpenWANativeAck } from '@/lib/whatsapp/transport/openwa/native-ack-provider'

export const runtime='nodejs'
export const dynamic='force-dynamic'
const headers={'Cache-Control':'private, no-store, max-age=0'}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type Context={params:Promise<{connectionId:string;jobId:string}>}

export async function POST(request:Request,context:Context) {
  if (!isOpenWATestProject())
    return NextResponse.json({error:'TEST only'},{status:403,headers})
  const {connectionId,jobId}=await context.params
  if (!UUID.test(connectionId)||!UUID.test(jobId))
    return NextResponse.json({error:'Invalid request'},{status:400,headers})

  let scope:Awaited<ReturnType<typeof requireOpenWASessionAdmin>>
  try {scope=await requireOpenWASessionAdmin()}
  catch {return NextResponse.json({error:'Session-admin access required'},{status:403,headers})}

  let body:Record<string,unknown>
  try {
    const parsed:unknown=await request.json()
    if (!parsed || typeof parsed!=='object' || Array.isArray(parsed))throw Error('bad json')
    body=parsed as Record<string,unknown>
  }catch {return NextResponse.json({error:'Invalid request'},{status:400,headers})}

  if (!['close_unverified','close_archive_observed'].includes(String(body.action)) ||
      body.confirm_no_resend!==true)
    return NextResponse.json({error:'Explicit no-resend confirmation required'},{status:400,headers})

  const {accountId,adminDb:db,user}=scope
  let archiveStatus:string|null=null
  if (body.action==='close_archive_observed') {
    try {
      const [connectionResult,jobResult]=await Promise.all([
        db.from('whatsapp_connections')
          .select('id,session_id,phone_identity,instance_id,status')
          .eq('account_id',accountId).eq('id',connectionId)
          .eq('provider','openwa').is('archived_at',null).maybeSingle(),
        db.from('openwa_deferred_events')
          .select('id,session_id,own_phone_identity,instance_id,provider_message_id')
          .eq('account_id',accountId).eq('connection_id',connectionId)
          .eq('id',jobId).eq('event_kind','unmatched_status')
          .in('state',['pending','review']).maybeSingle(),
      ])
      if (connectionResult.error||jobResult.error) throw Error('scope read error')
      if (!connectionResult.data||!jobResult.data)
        return NextResponse.json({error:'ACK not eligible'},{status:409,headers})
      const evidence=await inspectOpenWANativeAck(
        db,accountId,connectionId,connectionResult.data,jobResult.data,
      )
      if (evidence.code!=='archive_outbound_found'||!evidence.archive_status) {
        return NextResponse.json({
          updated:false, reason:'provider_evidence_unverified',
          delivery_confirmed:false, outbound_resent:false,
        },{status:409,headers})
      }
      archiveStatus=evidence.archive_status
    }catch {
      return NextResponse.json({error:'Provider evidence temporarily unavailable'},
        {status:503,headers})
    }
  }

  try {
    // The database independently checks actor role, account + connection,
    // unmatched status, no local match, and non-leased state under a row lock.
    // It atomically writes a terminal queue state + append-only minimal audit.
    const {data,error}=await db.rpc('close_openwa_unmatched_ack',{
      p_account_id:accountId,p_connection_id:connectionId,p_job_id:jobId,
      p_actor:user.id,
      p_finding:body.action==='close_archive_observed'
        ? 'gateway_archive_observed' : 'no_verified_evidence',
      p_gateway_status:archiveStatus,p_confirm_no_resend:true,
    })
    if (error) throw error
    if (!data || data.updated!==true) {
      return NextResponse.json({
        updated:false,
        reason:typeof data?.reason==='string' ? data.reason : 'not_eligible',
      },{status:409,headers})
    }
    return NextResponse.json({
      updated:true,disposition:data.disposition,
      delivery_confirmed:false,outbound_resent:false,
    },{status:200,headers})
  }catch {
    return NextResponse.json({error:'ACK disposition temporarily unavailable'},
      {status:503,headers})
  }
}
