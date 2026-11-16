/** Session-aware dashboard broadcast batches. WACRM owns the durable outbound ledger. */
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { BroadcastError, deliverBroadcast, finalizeBroadcastStatus, type BroadcastPlan } from '@/lib/whatsapp/broadcast-core'
import { resolveWhatsAppTransport } from '@/lib/whatsapp/transport/router'
import { resolveTemplateRow } from '@/lib/whatsapp/template-body'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
export const maxDuration = 120
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
interface Row {
  id: string; status: string; error_message: string | null; provider: 'meta_cloud' | 'openwa' | null
  connection_id: string | null; template_params: unknown
  contact: { phone?: string | null } | { phone?: string | null }[] | null
}
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const rate = checkRateLimit('broadcast:' + userId, RATE_LIMITS.broadcast)
    if (!rate.success) return rateLimitResponse(rate)
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    const id = body?.broadcast_id, ids = body?.recipient_ids
    if (typeof id !== 'string' || !UUID.test(id) || !Array.isArray(ids) || ids.length === 0 ||
      ids.length > 10 || ids.some((x) => typeof x !== 'string' || !UUID.test(x)) ||
      new Set(ids).size !== ids.length) {
      return NextResponse.json({ error: 'Campaign ID and 1–10 unique recipient IDs are required' }, { status: 400 })
    }
    const { data: campaign, error: campaignError } = await supabase.from('broadcasts')
      .select('id,template_name,template_language').eq('id', id).eq('account_id', accountId).maybeSingle()
    if (campaignError || !campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    const { data: recipients, error: recipientError } = await supabase.from('broadcast_recipients')
      .select('id,status,error_message,provider,connection_id,template_params,contact:contacts(phone)')
      .eq('broadcast_id', id).in('id', ids)
    if (recipientError || !recipients || recipients.length !== ids.length) {
      return NextResponse.json({ error: 'Campaign recipients not found in this account' }, { status: 403 })
    }
    const rows = recipients as Row[]
    const connectionId = rows[0].connection_id, provider = rows[0].provider
    if (!connectionId || !provider || rows.some((row) => row.connection_id !== connectionId || row.provider !== provider)) {
      return NextResponse.json({ error: 'Broadcast recipients must be pinned to a single WhatsApp connection' }, { status: 409 })
    }
    const transport = await resolveWhatsAppTransport(supabase, accountId, connectionId)
    if (transport.connectionId !== connectionId || transport.transport.provider !== provider) {
      return NextResponse.json({ error: 'WhatsApp sender identity changed' }, { status: 409 })
    }
    const template = await resolveTemplateRow(supabase, accountId, campaign.template_name, campaign.template_language)
    if (template.malformed) return NextResponse.json({ error: 'Malformed broadcast template' }, { status: 400 })
    if (provider === 'openwa' && ['image','video','document'].includes(template.row?.header_type ?? '')) {
      return NextResponse.json({ error: 'OpenWA supports text-only broadcasts; Meta media headers are not portable' }, { status: 400 })
    }
    const rawHeader = body?.message_params && typeof body.message_params === 'object' && !Array.isArray(body.message_params)
      ? body.message_params as Record<string, unknown> : null
    const headerMediaUrl = rawHeader && typeof rawHeader.headerMediaUrl === 'string' && /^https:\/\//.test(rawHeader.headerMediaUrl)
      ? rawHeader.headerMediaUrl : undefined
    const plan: BroadcastPlan = {
      accountId, broadcastId: id, connectionId, provider, templateName: campaign.template_name,
      templateLanguage: template.language, templateRow: template.row, rejected: 0,
      planned: rows.map((row) => {
        const contact = Array.isArray(row.contact) ? row.contact[0] : row.contact
        const phone = sanitizePhoneForMeta(contact?.phone ?? '')
        if (!isValidE164(phone)) throw new BroadcastError('recipient_invalid', 'Recipient phone must be corrected before dispatch', 400)
        return {
          recipientRowId: row.id, phone, status: row.status, errorMessage: row.error_message,
          params: Array.isArray(row.template_params) ? row.template_params.filter((x): x is string => typeof x === 'string') : [],
          messageParams: headerMediaUrl ? { headerMediaUrl } : undefined,
        }
      }),
    }
    const results = await deliverBroadcast(supabase, plan)
    await finalizeBroadcastStatus(supabase, id)
    return NextResponse.json({ success: true, results })
  } catch (error) {
    if (error instanceof BroadcastError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    console.error('[whatsapp-broadcast] provider-neutral delivery error:', error)
    return toErrorResponse(error)
  }
}
