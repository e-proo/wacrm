import { isOpenWATestProject } from '@/lib/whatsapp/transport/openwa/environment'

export function scopedInboxEnabled(env=process.env): boolean {
 return isOpenWATestProject(env.NEXT_PUBLIC_SUPABASE_URL) && env.WACRM_INBOX_READ_API==='test_only' && env.WACRM_INBOX_SCOPED_UI==='test_only'
}

// Independently gated writer. Neither the read flag nor policy preview enables it.
export function scopedInboxActionsEnabled(env=process.env):boolean {
 return scopedInboxEnabled(env)&&env.WACRM_INBOX_ACTIONS==='test_only'
}
