import { supabaseAdmin } from '@/lib/ai/admin-client'
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'
import { resolveConversationTransport } from '@/lib/whatsapp/transport/router'
import { resolveOpenWAConversationRecipient } from '@/lib/whatsapp/transport/openwa/recipient'
import { openWAPilotRecipientHash } from '@/lib/whatsapp/transport/guardrails'
import { resolveBusinessEventSendWorkload } from './business-event-delivery-workload'
import { deliverActiveBusinessEventNotifications } from './business-event-delivery'

export class SafeOutcomeRecoveryError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message)
    this.name = 'SafeOutcomeRecoveryError'
  }
}

function blocked(code: string, message: string): never {
  throw new SafeOutcomeRecoveryError(code, message)
}

/**
 * Admin explicitly confirms the approved supplier terms and requests exactly
 * one recovery of a business-event message that WACRM proved never reached
 * OpenWA. Provider timeouts, in-flight/sent rows and other notices cannot
 * enter this path. SQL requeue + message audit update are one transaction.
 */
export async function retryConfirmedAgentTaskSupplierOutcome(input: {
  accountId: string
  changeRequestId: string
  actorUserId: string
  supplierTermsReviewed: boolean
}): Promise<{ status: 'provider_accepted' | 'reconciliation_required' | 'blocked'; message: string }> {
  if (!input.supplierTermsReviewed) blocked(
    'SUPPLIER_TERMS_REVIEW_REQUIRED',
    'راجع مسار التغطية ومبلغ العرض وتفاصيل المورد المعتمدة أولًا؛ قد تختلف التفاصيل النصية عن المسار المحفوظ.',
  )
  const db = supabaseAdmin()
  const { data: request, error: requestError } = await db.from('change_requests')
    .select('id,status,action_key').eq('account_id',input.accountId)
    .eq('id',input.changeRequestId).maybeSingle()
  if (requestError) throw requestError
  if (!request || request.status !== 'executed' || request.action_key !== 'coverage.offer.create') {
    blocked('SUPPLIER_OUTCOME_NOT_EXECUTED','يجب أن يكون عرض التغطية منفّذًا قبل محاولة إشعار المورد.')
  }
  const { data: event, error: eventError } = await db.from('business_event_outbox')
    .select('id,event_type,event_version,subject_type,subject_id,correlation_id,contact_id,conversation_id,status,last_error,local_message_id')
    .eq('account_id',input.accountId).eq('correlation_id',input.changeRequestId)
    .eq('event_type','coverage.offer.approved').limit(2)
  if (eventError) throw eventError
  if (!event || event.length !== 1) blocked('SUPPLIER_OUTCOME_NOT_UNIQUE','تعذر تحديد إشعار عرض واحد صالح للاستكمال.')
  const outcome = event[0]
  if (!['requires_reconciliation','failed'].includes(outcome.status) ||
      !outcome.local_message_id || !outcome.contact_id || !outcome.conversation_id) {
    blocked('SUPPLIER_OUTCOME_NOT_SAFE_TO_RETRY',
      'الإشعار ليس حالة رفض مؤكدة قبل الإرسال. قد يكون قيد الإرسال أو وصل بالفعل؛ لا إعادة تلقائية.')
  }
  const provenance = await resolveBusinessEventSendWorkload(db,input.accountId,outcome)
  if (provenance !== 'agent') {
    blocked('SUPPLIER_OUTCOME_NOT_AGENT_BOUND','لم يثبت ارتباط إشعار النتيجة بمهمة المورد المعتمدة.')
  }
  const { data: failed, error: failedError } = await db.from('messages')
    .select('id,connection_id,provider,status,message_id,provider_message_id')
    .eq('id',outcome.local_message_id).eq('conversation_id',outcome.conversation_id)
    .maybeSingle()
  if (failedError) throw failedError
  if (!failed || failed.provider !== 'openwa' || !failed.connection_id ||
      failed.status !== 'failed' || failed.message_id || failed.provider_message_id) {
    blocked('SUPPLIER_OUTCOME_PROVIDER_UNCERTAIN',
      'لا يوجد دليل كافٍ أن الإرسال السابق توقف قبل الوصول إلى المزود.')
  }
  const { data: contact, error: contactError } = await db.from('contacts')
    .select('phone').eq('account_id',input.accountId).eq('id',outcome.contact_id).maybeSingle()
  if (contactError) throw contactError
  if (!contact?.phone) blocked('SUPPLIER_OUTCOME_CONTACT_MISSING','جهة اتصال المورد غير موجودة.')
  const resolved = await resolveConversationTransport(db,input.accountId,outcome.conversation_id)
  if (resolved.connectionId !== failed.connection_id || resolved.transport.provider !== 'openwa') {
    blocked('SUPPLIER_OUTCOME_SESSION_CHANGED',
      'المحادثة تغيّرت جلسة إرسالها منذ محاولة الإشعار؛ لا يمكن إعادة الإرسال بلا مراجعة الجلسة.')
  }
  const { data: fence, error: fenceError } = await db.from('whatsapp_connection_guardrails')
    .select('pilot_enabled,manual_paused,circuit_open_until')
    .eq('account_id',input.accountId).eq('connection_id',failed.connection_id).maybeSingle()
  if (fenceError) throw fenceError
  if (!fence || fence.pilot_enabled !== true || fence.manual_paused !== false ||
      (fence.circuit_open_until && Date.parse(fence.circuit_open_until) > Date.now())) {
    blocked('SUPPLIER_OUTCOME_PILOT_PAUSED',
      'Pilot أو جلسة OpenWA موقوفة. فعّل الجلسة قبل إرسال إشعار المورد.')
  }
  const recipient = await resolveOpenWAConversationRecipient(db,{
    accountId:input.accountId,
    conversationId:outcome.conversation_id,
    connectionId:failed.connection_id,
    fallbackPhone:sanitizePhoneForMeta(contact.phone),
  })
  const hash = openWAPilotRecipientHash(input.accountId,failed.connection_id,recipient)
  if (!hash) blocked('SUPPLIER_OUTCOME_NATIVE_ID_INVALID','تعذّر التحقق من هوية محادثة المورد.')
  const { data: grant, error: grantError } = await db.from('whatsapp_openwa_pilot_allowlist')
    .select('id').eq('account_id',input.accountId).eq('connection_id',failed.connection_id)
    .eq('recipient_hash',hash).eq('workload','agent').eq('active',true)
    .gt('expires_at',new Date().toISOString()).maybeSingle()
  if (grantError) throw grantError
  if (!grant) blocked('SUPPLIER_OUTCOME_AGENT_CONSENT_MISSING',
    'اعتماد جهة المورد لنوع agent في Pilot انتهى أو غير موجود في هذه الجلسة.')
  const { data: owner, error: ownerError } = await db.from('whatsapp_config')
    .select('user_id').eq('account_id',input.accountId).maybeSingle()
  if (ownerError) throw ownerError
  if (!owner?.user_id) blocked('SUPPLIER_OUTCOME_SENDER_MISSING','إعداد مرسل واتساب غير جاهز.')

  const { error: requeueError } = await db.rpc('requeue_verified_openwa_predispatch_business_event', {
    p_account_id:input.accountId,
    p_change_request_id:input.changeRequestId,
    p_actor_user_id:input.actorUserId,
  })
  if (requeueError) {
    console.warn('[business outcome recovery] requeue refused', { code:requeueError.code ?? 'unknown' })
    blocked('SUPPLIER_OUTCOME_REARM_REFUSED',
      'تعذّر إثبات أن الإرسال القديم لم يصل؛ لن يعيد النظام إرسال رسالة قد تكون وصلت.')
  }

  const result = await deliverActiveBusinessEventNotifications({
    accountId:input.accountId, userId:owner.user_id,
    correlationId:input.changeRequestId,
    subjectType:outcome.subject_type, subjectId:outcome.subject_id, limit:1,
  })
  if (result.sent === 1) return {
    status:'provider_accepted',
    message:'قبل OpenWA إشعار اعتماد المورد. انتظر تأكيد الوصول إلى هاتفه؛ لا يعني القبول التسليم.',
  }
  if (result.reconciliation > 0) return {
    status:'reconciliation_required',
    message:'حالة إرسال إشعار المورد غير مؤكدة؛ افحص المطابقة قبل أي محاولة أخرى.',
  }
  return { status:'blocked',
    message:'لم يقبل المزود إرسال إشعار المورد. راجع إعدادات Pilot وحالة الرسالة، ولا تعاود الإرسال عشوائيًا.' }
}
