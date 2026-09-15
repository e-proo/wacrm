import type { SupabaseClient } from '@supabase/supabase-js'

export interface ApplyAgentHumanHandoffInput {
  db: SupabaseClient
  accountId: string
  runId: string
  conversationId: string
  contactId: string | null
  targetUserId: string | null
  summary: string
}

export interface ApplyAgentHumanHandoffResult {
  assignedUserId: string | null
  assignmentChanged: boolean
  explicitNotificationCreated: boolean
}

export async function applyAgentHumanHandoff(
  input: ApplyAgentHumanHandoffInput,
): Promise<ApplyAgentHumanHandoffResult> {
  const { db, accountId, runId, conversationId, contactId, targetUserId } = input
  const summary = input.summary.trim().slice(0, 1200) || 'AI requested a human handoff.'

  const [conversationRes, runRes] = await Promise.all([
    db
      .from('conversations')
      .select('id, assigned_agent_id')
      .eq('account_id', accountId)
      .eq('id', conversationId)
      .maybeSingle(),
    db
      .from('ai_agent_runs')
      .select('created_at')
      .eq('account_id', accountId)
      .eq('id', runId)
      .maybeSingle(),
  ])
  if (conversationRes.error) throw conversationRes.error
  if (runRes.error) throw runRes.error
  if (!conversationRes.data) throw new Error('HANDOFF_CONVERSATION_NOT_FOUND')

  let assignedUserId: string | null = null
  if (targetUserId) {
    const { data: member, error: memberError } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .eq('user_id', targetUserId)
      .maybeSingle()
    if (memberError) throw memberError
    if (!member) throw new Error('HANDOFF_MEMBER_NOT_IN_ACCOUNT')
    assignedUserId = targetUserId
  }

  const previousAssignee = (conversationRes.data as { assigned_agent_id: string | null }).assigned_agent_id
  const assignmentChanged = Boolean(assignedUserId && previousAssignee !== assignedUserId)
  const patch: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: summary,
  }
  if (assignedUserId) patch.assigned_agent_id = assignedUserId

  const { error: updateError } = await db
    .from('conversations')
    .update(patch)
    .eq('account_id', accountId)
    .eq('id', conversationId)
  if (updateError) throw updateError

  let explicitNotificationCreated = false
  if (assignedUserId) {
    // Assignment changes are normally notified by migration 027's trigger. On
    // retries (or when the same teammate was already assigned) there is no
    // UPDATE transition, so confirm this durable run already has a matching
    // notification before adding an idempotent run-keyed fallback.
    const runCreatedAt = (runRes.data as { created_at?: string } | null)?.created_at
    let existingQuery = db
      .from('notifications')
      .select('id')
      .eq('account_id', accountId)
      .eq('user_id', assignedUserId)
      .eq('conversation_id', conversationId)
      .eq('type', 'conversation_assigned')
    if (runCreatedAt) existingQuery = existingQuery.gte('created_at', runCreatedAt)
    const { data: existing, error: existingError } = await existingQuery.limit(1).maybeSingle()
    if (existingError) throw existingError
    if (!existing) {
      const { error: notificationError } = await db
        .from('notifications')
        .upsert(
          {
            id: runId,
            account_id: accountId,
            user_id: assignedUserId,
            type: 'conversation_assigned',
            conversation_id: conversationId,
            contact_id: contactId,
            actor_user_id: null,
            title: 'AI handoff requested',
            body: summary,
            read_at: null,
          },
          { onConflict: 'id', ignoreDuplicates: true },
        )
      if (notificationError) throw notificationError
      explicitNotificationCreated = true
    }
  }

  return { assignedUserId, assignmentChanged, explicitNotificationCreated }
}

export function localizedHandoffAcknowledgement(input: string): string {
  return /[؀-ۿ]/.test(input)
    ? 'تم تحويل محادثتك إلى أحد الموظفين لمتابعتها، وسيتم الرد عليك هنا.'
    : 'I have handed this conversation to a team member for follow-up. They will reply here.'
}

export function localizedAdminFallback(input: string): string {
  return /[؀-ۿ]/.test(input)
    ? 'تعذر على وكيل الإدارة إكمال هذا الطلب آليًا. راجع إعدادات الوكيل وصلاحيات أدواته أو أعد صياغة الطلب بمعلومات أكثر تحديدًا.'
    : 'The admin agent could not complete this request automatically. Check its tool grants/settings or retry with more specific details.'
}
