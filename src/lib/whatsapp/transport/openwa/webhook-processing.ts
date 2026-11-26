import { NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { normalizeOpenWAInboundMessage, normalizeOpenWAOwnSentMessage } from '@/lib/whatsapp/inbound-normalization'
import { processOpenWAOwnSentEcho } from '@/lib/whatsapp/transport/openwa/outbound-echo'
import { deferOpenWAWebhook, preflightOpenWAInboundIdentity } from '@/lib/whatsapp/transport/openwa/deferred'
import { isSensitiveOpenWAAdminOwnSentEcho } from '@/lib/whatsapp/transport/openwa/admin-approval-echo'
import { extractOpenWASignedInlineMedia } from '@/lib/whatsapp/transport/openwa/webhook-media'
import { processNormalizedInboundMessage } from '@/lib/whatsapp/inbound-processor'
import { applyOpenWAStatusWithRetry, parseOpenWAStatusEvent } from '@/lib/whatsapp/status-lifecycle'
import { markOpenWAWebhookProcessed, type OpenWAWebhookEnvelope } from '@/lib/whatsapp/transport/openwa/webhook'
import { refreshOpenWAConnectionStatus } from '@/lib/whatsapp/transport/openwa/session-lifecycle'
import { reconcileCanonicalAck, reconcileCanonicalEcho } from '@/lib/inbox/canonical-outbound'
import { hasExplicitCanonicalPeer, holdCanonicalReview } from '@/lib/inbox/canonical-ingress'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

export function createOpenWAWebhookDb():SupabaseClient { const url=process.env.NEXT_PUBLIC_SUPABASE_URL;const key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!url||!key)throw Error('Server database credentials are not configured');return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}}) }

/** Single business pipeline for synchronous and durably accepted signed events. */
export async function processReservedOpenWAWebhook(db:SupabaseClient,reservation:{accountId:string;connectionId:string;envelope:OpenWAWebhookEnvelope;processingToken:string},canonicalMode:boolean,strictReceipt=false){
  const {accountId,connectionId,envelope,processingToken}=reservation
  try {
    const canonicalReceipt = canonicalMode
      ? { eventId: envelope.eventId, token: processingToken, sessionId: envelope.sessionId, instanceId: envelope.instanceId ?? null }
      : null
      const event = envelope.event.toLowerCase().replace(/[\s_-]+/g, '.')
      if (['session.status', 'session.authenticated', 'session.disconnected', 'session.restriction'].includes(event)) {
        await refreshOpenWAConnectionStatus(db, accountId, connectionId)
      } else if (['status', 'message.status', 'message.ack', 'message.receipt', 'message.failed', 'ack', 'delivery', 'receipt'].includes(event)) {
        const status = parseOpenWAStatusEvent(envelope.data)
        if (status) {
          const result = canonicalReceipt
            ? await reconcileCanonicalAck(db, { provider: 'openwa', accountId, connectionId, ...status }, canonicalReceipt)
            : await applyOpenWAStatusWithRetry(db, { provider: 'openwa', accountId, connectionId, ...status })
          if (result === 'unknown') {
            // No provider payload, recipient or message contents in logs.
            // Long-running ambiguous sends must be reconciled, not resent.
            await deferOpenWAWebhook(db, {
              accountId, connectionId, sessionId: envelope.sessionId,
              providerEventId: envelope.eventId,
              providerMessageId: status.providerMessageId, processingToken,
              deferred: { kind: 'unmatched_status', status },
            })
            // The queue insert and signed receipt finalization committed
            // atomically. Another signed retry is now a safe duplicate.
            return NextResponse.json({ ok: true, deferred: 'pending_receipt' }, { status: 202 })
          }
        } else {
          if(strictReceipt)throw Error('Delivery receipt unrecognized')
          console.warn('[openwa-webhook] unrecognized delivery receipt', { connectionId, event })
        }
      } else if (event === 'message.sent') {
        const ownSent = normalizeOpenWAOwnSentMessage(envelope, connectionId)
        if (ownSent && !isSensitiveOpenWAAdminOwnSentEcho(ownSent) && canonicalReceipt) {
          const { data: account, error: accountError } = await db.from('accounts').select('owner_user_id').eq('id', accountId).maybeSingle()
          if (accountError || !account?.owner_user_id) throw new Error('OpenWA account owner could not be resolved')
          await reconcileCanonicalEcho({ db, storage: db.storage, accountId, ownerUserId: account.owner_user_id, message: ownSent,
            receipt: canonicalReceipt, signedInlineMedia: extractOpenWASignedInlineMedia(envelope), ...(strictReceipt?{strictReceipt:true}:{}) })
        } else if (ownSent && !isSensitiveOpenWAAdminOwnSentEcho(ownSent)) {
          const { data: account, error: accountError } = await db.from('accounts')
            .select('owner_user_id').eq('id', accountId).maybeSingle()
          if (accountError || !account?.owner_user_id) throw new Error('OpenWA account owner could not be resolved')
          const echo=await processOpenWAOwnSentEcho({
            db, storage: db.storage, accountId, connectionId,
            ownerUserId: account.owner_user_id, message: ownSent,
            signedInlineMedia: extractOpenWASignedInlineMedia(envelope), ...(strictReceipt?{strictReceipt:true}:{}),
          })
          if(strictReceipt&&echo==='ignored')throw Error('Own-sent source unconfirmed')
        }
      } else {
        const normalized = normalizeOpenWAInboundMessage(envelope, connectionId)
        if (normalized) {
          if (canonicalReceipt && normalized.message.type === 'reaction') {
            await holdCanonicalReview(db, accountId, normalized.message, canonicalReceipt, 'reaction_unproven')
            await markOpenWAWebhookProcessed(db, accountId, connectionId, envelope.eventId, processingToken)
            return NextResponse.json({ ok: true, deferred: 'canonical_review' }, { status: 202 })
          }
          // Identity preflight runs BEFORE any CRM/AI side effect.
          // Unknown native LIDs must be stored durably, never guessed.
          const identity = await preflightOpenWAInboundIdentity(db, {
            accountId, connectionId, sessionId: envelope.sessionId, inbound: normalized,
          })
          if (identity === 'unresolved' || (canonicalReceipt && !hasExplicitCanonicalPeer(normalized.message))) {
            await deferOpenWAWebhook(db, {
              accountId, connectionId, sessionId: envelope.sessionId,
              providerEventId: envelope.eventId,
              providerMessageId: normalized.message.providerMessageId,
              processingToken, deferred: { kind: 'unresolved_identity', inbound: normalized },
            })
            return NextResponse.json({ ok: true, deferred: 'pending_identity' }, { status: 202 })
          }
          const { data: account, error: accountError } = await db.from('accounts').select('owner_user_id').eq('id', accountId).maybeSingle()
          if (accountError || !account?.owner_user_id) throw new Error('OpenWA account owner could not be resolved')
          if(strictReceipt)await processNormalizedInboundMessage(normalized.message,normalized.contact,accountId,connectionId,account.owner_user_id,'',true,extractOpenWASignedInlineMedia(envelope),canonicalReceipt??undefined,undefined,true)
          else if (canonicalReceipt) await processNormalizedInboundMessage(normalized.message, normalized.contact, accountId, connectionId, account.owner_user_id, '', true, extractOpenWASignedInlineMedia(envelope), canonicalReceipt)
          else await processNormalizedInboundMessage(normalized.message, normalized.contact, accountId, connectionId, account.owner_user_id, '', true, extractOpenWASignedInlineMedia(envelope))
        }
      }
    await markOpenWAWebhookProcessed(db, accountId, connectionId, envelope.eventId, processingToken)
    return NextResponse.json({ ok: true }, { status: 202 })
  } catch (error) {
    // Never persist or log arbitrary upstream error messages, provider
    // payloads or credentials. A failed attempt remains recoverable.
    const code = error instanceof WhatsAppTransportError
      ? error.code : error instanceof Error && error.name === 'AbortError'
        ? 'aborted' : 'processing_failed'
    try {
      await markOpenWAWebhookProcessed(db, accountId, connectionId, envelope.eventId, processingToken, code)
    } catch {
      console.error('[openwa-webhook] could not release processing lease', { connectionId })
    }
    console.warn('[openwa-webhook] processing outcome unconfirmed', { connectionId, code })
    return NextResponse.json({ error: 'OpenWA webhook processing deferred', code: 'processing_retry' }, {
      status: 503, headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' },
    })
  }
}
