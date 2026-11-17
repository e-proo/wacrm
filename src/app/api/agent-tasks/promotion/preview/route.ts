import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { inspectServicePromotionCampaign, ServicePromotionReviewError } from '@/lib/services/service-catalog/promotion-campaign-review'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store, max-age=0' }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Server-owned inspection. No write, no cohort freeze in the DB, no send.
 * The operator must review the exact connection, provider and recipients.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireAgentCapability('agents.manage_tasks')
    await requireAgentCapability('agents.manage_outreach')
    const params = new URL(request.url).searchParams
    const serviceId = params.get('serviceId')
    const agentId = params.get('agentId')
    const connectionId = params.get('connectionId')
    if (!serviceId || !agentId || !connectionId ||
        ![serviceId, agentId, connectionId].every(id => UUID_RE.test(id))) {
      return NextResponse.json({ code: 'SERVICE_PROMOTION_PREVIEW_INVALID_INPUT',
        error: 'اختر الخدمة والوكيل واتصال WhatsApp.' }, { status: 400, headers })
    }
    const review = await inspectServicePromotionCampaign(supabaseAdmin(), {
      accountId: ctx.accountId, serviceId, agentId, connectionId,
    })
    const reviewedAt = new Date().toISOString()
    const readyForApproval = review.blockers.length === 0
    return NextResponse.json({
      previewOnly: true,
      readyForApproval,
      readyForLaunch: false, // Preview never authorizes sending.
      reviewedAt,
      expiresAt: new Date(Date.parse(reviewedAt) + 10 * 60_000).toISOString(),
      fingerprint: review.fingerprint,
      service: review.service,
      agent: review.agent,
      connection: review.connection,
      audience: {
        total: review.audience.count,
        contacts: review.audience.contacts,
        policyMax: review.audience.max,
        requiredTagIds: review.audience.requiredTags,
        excludedTagIds: review.audience.excludedTags,
      },
      message: review.firstMessage,
      template: review.template,
      consent: { verifiedByPlatform: review.connection.provider === 'openwa' &&
          !review.blockers.some(x => x.includes('PILOT')),
        operatorAttestationRequired: true },
      blockers: review.blockers,
    }, { headers })
  } catch (error) {
    if (error instanceof ServicePromotionReviewError) {
      return NextResponse.json({ error: error.message, code: error.code },
        { status: error.status, headers })
    }
    if (error instanceof Error && error.message.startsWith('SERVICE_PROMOTION_')) {
      return NextResponse.json({ error: error.message, code: error.message },
        { status: 409, headers })
    }
    return toErrorResponse(error)
  }
}
