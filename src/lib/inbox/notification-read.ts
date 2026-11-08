import type { SupabaseClient } from '@supabase/supabase-js'

/** Viewing a conversation acknowledges only this user's notifications for
 * that conversation in the same account. RLS also enforces auth.uid(). */
export async function markConversationNotificationsRead(
  db: SupabaseClient,
  scope: { accountId: string; conversationId: string; userId: string },
): Promise<void> {
  if (!scope.accountId || !scope.conversationId || !scope.userId) return

  const { error } = await db.from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('account_id', scope.accountId)
    .eq('conversation_id', scope.conversationId)
    .eq('user_id', scope.userId)
    .is('read_at', null)

  if (error) throw error
}
