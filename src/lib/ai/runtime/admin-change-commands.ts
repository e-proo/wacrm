import type { TrustedAdminIdentity } from './multi-agent-types'
import {
  approveChangeRequestFromTrustedAdmin,
  rejectChangeRequest,
} from './change-requests-service'
import { executeApprovedChangeRequest } from './change-request-executor'
import { supabaseAdmin } from '../admin-client'

export type AdminChangeCommandResult =
  | { handled: false }
  | { handled: true; reply: string }

/**
 * Deterministic command parser for explicit WhatsApp approvals/rejections.
 * Free-form model output never enters this path.
 */
export async function handleAdminChangeCommand(input: {
  accountId: string
  identity: TrustedAdminIdentity
  inboundMessageId: string
  text: string
}): Promise<AdminChangeCommandResult> {
  const text = input.text.trim()
  const approve = text.match(/^(?:اعتماد|approve)\s+CHG-(\d+)\s+(\d{4})$/i)
  const reject = text.match(/^(?:رفض|reject)\s+CHG-(\d+)$/i)
  if (!approve && !reject) return { handled: false }

  if (!input.identity.allowedCapabilities.includes('change_requests.approve')) {
    return { handled: true, reply: 'هذا الرقم الإداري لا يملك صلاحية اعتماد أو رفض طلبات التغيير.' }
  }

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
      const result = await executeApprovedChangeRequest({
        accountId: input.accountId,
        changeRequestId: approved.id,
        actorUserId: input.identity.memberId,
      })
      return {
        handled: true,
        reply: `تم اعتماد وتنفيذ CHG-${requestCode}. الحالة: ${String(result.status ?? 'executed')}.`,
      }
    }

    const requestCode = Number(reject![1])
    const db = supabaseAdmin()
    const { data: request, error } = await db
      .from('change_requests')
      .select('id, status')
      .eq('account_id', input.accountId)
      .eq('code', requestCode)
      .maybeSingle()
    if (error) throw error
    if (!request) return { handled: true, reply: `لم يتم العثور على CHG-${requestCode}.` }
    const rejected = await rejectChangeRequest({
      accountId: input.accountId,
      changeRequestId: request.id,
      actorUserId: input.identity.memberId,
      reason: 'Rejected by trusted administrator via WhatsApp',
    })
    return { handled: true, reply: `تم رفض CHG-${requestCode}. الحالة: ${rejected.status}.` }
  } catch (err) {
    const code = err instanceof Error ? err.message : 'unknown error'
    console.error('[admin change command] failed:', err)
    return { handled: true, reply: `تعذر تنفيذ أمر طلب التغيير: ${safeError(code)}` }
  }
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
