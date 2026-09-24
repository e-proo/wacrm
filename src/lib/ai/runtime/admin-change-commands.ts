import type { SupabaseClient } from '@supabase/supabase-js'
import type { TrustedAdminIdentity } from './multi-agent-types'
import {
  approveChangeRequestFromTrustedAdmin,
  rejectChangeRequest,
} from './change-requests-service'
import { executeApprovedChangeRequest } from './change-request-executor'
import { deliverCustomerOutcomeNotifications } from './customer-notification-delivery'
import { supabaseAdmin } from '../admin-client'
import { renderChangeRequestAdminOutcomeMessage } from '@/lib/messaging/change-request-admin-outcome'
import { createSupabaseTemplateOverrideStore } from '@/lib/messaging/supabase-store'

export type AdminChangeCommandResult =
  | { handled: false }
  | { handled: true; reply: string }

type DeliveryResult = Awaited<ReturnType<typeof deliverCustomerOutcomeNotifications>>

interface ChangeRequestAdminContextRow {
  target_type: string
  summary: string | null
  proposed_payload: Record<string, unknown> | null
}

/**
 * Deterministic command parser for explicit WhatsApp approvals/rejections.
 * Free-form model output never enters this path. Business state is committed
 * before the outcome copy is rendered; templates cannot decide the outcome.
 */
export async function handleAdminChangeCommand(input: {
  accountId: string
  identity: TrustedAdminIdentity
  inboundMessageId: string
  text: string
}): Promise<AdminChangeCommandResult> {
  const text = input.text.trim()
  const approve = text.match(/^(?:اعتماد|approve)\s+CHG-(\d+)\s+(\d{4})$/i)
  const reject = text.match(/^(?:رفض|reject)\s+CHG-(\d+)(?:\s+(.{1,500}))?$/i)
  if (!approve && !reject) return { handled: false }

  if (!input.identity.allowedCapabilities.includes('change_requests.approve')) {
    return { handled: true, reply: 'هذا الرقم الإداري لا يملك صلاحية اعتماد أو رفض طلبات التغيير.' }
  }

  const db = supabaseAdmin()

  try {
    if (approve) {
      const requestCode = Number(approve[1])
      const approved = await approveChangeRequestFromTrustedAdmin({
        accountId: input.accountId,
        requestCode,
        confirmationCode: approve[2],
        identityId: input.identity.id,
        inboundMessageId: input.inboundMessageId,
      })
      if (approved.status !== 'approved' && approved.status !== 'executed') {
        return { handled: true, reply: `تعذر اعتماد CHG-${requestCode}: الحالة ${approved.status}.` }
      }

      await executeApprovedChangeRequest({
        accountId: input.accountId,
        changeRequestId: approved.id,
        actorUserId: input.identity.memberId,
      })

      const delivery = await deliverCustomerOutcomeBestEffort(
        input.accountId,
        approved.id,
        requestCode,
      )
      const request = await loadChangeRequestAdminContext(db, input.accountId, approved.id)
      const rendered = await renderChangeRequestAdminOutcomeMessage({
        accountId: input.accountId,
        changeRequestId: approved.id,
        requestCode,
        outcome: 'approved',
        targetType: request?.target_type ?? 'change_request',
        proposedPayload: request?.proposed_payload ?? null,
        summary: request?.summary ?? null,
        customerDeliveryLabel: customerDeliveryLabel(delivery, 'approved'),
        store: createSupabaseTemplateOverrideStore(db),
      })
      logRenderedOutcome(rendered, 'change_request.approved')
      return { handled: true, reply: rendered.text }
    }

    const requestCode = Number(reject![1])
    const { data: request, error } = await db
      .from('change_requests')
      .select('id, status, target_type, summary, proposed_payload')
      .eq('account_id', input.accountId)
      .eq('code', requestCode)
      .maybeSingle()
    if (error) throw error
    if (!request) return { handled: true, reply: `لم يتم العثور على CHG-${requestCode}.` }

    const providedReason = reject?.[2]?.trim() || null
    const storedReason = providedReason || 'Rejected by trusted administrator via WhatsApp'
    const rejected = await rejectChangeRequest({
      accountId: input.accountId,
      changeRequestId: request.id,
      actorUserId: input.identity.memberId,
      reason: storedReason,
    })
    const delivery = await deliverCustomerOutcomeBestEffort(
      input.accountId,
      request.id,
      requestCode,
    )
    const rendered = await renderChangeRequestAdminOutcomeMessage({
      accountId: input.accountId,
      changeRequestId: request.id,
      requestCode,
      outcome: 'rejected',
      targetType: request.target_type,
      proposedPayload: asRecord(request.proposed_payload),
      summary: request.summary,
      reason: providedReason || 'رفضه المسؤول عبر واتساب',
      customerDeliveryLabel: customerDeliveryLabel(delivery, 'rejected'),
      store: createSupabaseTemplateOverrideStore(db),
    })
    logRenderedOutcome(rendered, 'change_request.rejected')
    return { handled: true, reply: rendered.text }
  } catch (err) {
    const code = err instanceof Error ? err.message : 'unknown error'
    console.error('[admin change command] failed:', err)
    return { handled: true, reply: `تعذر تنفيذ أمر طلب التغيير: ${safeError(code)}` }
  }
}

async function deliverCustomerOutcomeBestEffort(
  accountId: string,
  changeRequestId: string,
  requestCode: number,
): Promise<DeliveryResult | null> {
  try {
    const delivery = await deliverCustomerOutcomeNotifications({
      accountId,
      changeRequestId,
    })
    console.info(
      `[admin change command] CHG-${requestCode} customer notifications claimed=${delivery.claimed} sent=${delivery.sent} reconcile=${delivery.reconciliation} failed=${delivery.failed}`,
    )
    return delivery
  } catch (notifyError) {
    // The human decision + deterministic business mutation already succeeded.
    // Notification failure is a follow-up concern and must never roll it back.
    console.error(
      `[admin change command] CHG-${requestCode} customer notification delivery failed:`,
      notifyError,
    )
    return null
  }
}

async function loadChangeRequestAdminContext(
  db: SupabaseClient,
  accountId: string,
  changeRequestId: string,
): Promise<ChangeRequestAdminContextRow | null> {
  const { data, error } = await db
    .from('change_requests')
    .select('target_type, summary, proposed_payload')
    .eq('account_id', accountId)
    .eq('id', changeRequestId)
    .maybeSingle()
  if (error) {
    console.error('[admin change command] outcome context lookup failed:', error)
    return null
  }
  if (!data) return null
  return {
    target_type: data.target_type,
    summary: data.summary,
    proposed_payload: asRecord(data.proposed_payload),
  }
}

function customerDeliveryLabel(
  delivery: DeliveryResult | null,
  outcome: 'approved' | 'rejected',
): string | null {
  if (!delivery) return 'تعذر التحقق من إرسال إشعار العميل'
  if (delivery.sent > 0) {
    return outcome === 'approved' ? 'تم إشعاره بالنتيجة ✅' : 'تم إشعاره بالرفض ✅'
  }
  if (delivery.reconciliation > 0) return 'إشعار العميل يحتاج مطابقة حالة الإرسال'
  if (delivery.failed > 0) return 'تعذر إرسال إشعار النتيجة؛ بقي مسجلاً للمراجعة'
  if (delivery.claimed === 0) return 'لا يوجد إشعار جديد بانتظار الإرسال'
  return null
}

function logRenderedOutcome(
  rendered: Awaited<ReturnType<typeof renderChangeRequestAdminOutcomeMessage>>,
  eventKey: string,
): void {
  console.info(
    [
      `[messaging] event=${eventKey}`,
      `source=${rendered.source}`,
      `template=${rendered.resolvedEventKey}`,
      `locale=${rendered.resolvedLocale}`,
      'channel=whatsapp',
      rendered.revisionId ? `revision=${rendered.revisionId}` : null,
      rendered.version != null ? `version=${rendered.version}` : null,
      rendered.fallbackReason ? `fallback=${rendered.fallbackReason}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' '),
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function safeError(message: string): string {
  const known = [
    'CHANGE_REQUEST_NOT_FOUND',
    'CHANGE_REQUEST_EXPIRED',
    'CHANGE_REQUEST_BAD_CODE',
    'CHANGE_REQUEST_TOO_MANY_ATTEMPTS',
    'CHANGE_REQUEST_CONTENT_CHANGED',
    'EXPECTED_VERSION_CONFLICT',
    'EXECUTION_CLAIM_LOST',
  ]
  return known.find((code) => message.includes(code)) ?? 'تعذر تنفيذ الطلب بأمان.'
}
