import { isOpenWATestProject } from '@/lib/whatsapp/transport/openwa/environment'

export function scopedInboxEnabled(env=process.env): boolean {
 return isOpenWATestProject(env.NEXT_PUBLIC_SUPABASE_URL) && env.WACRM_INBOX_READ_API==='test_only' && env.WACRM_INBOX_SCOPED_UI==='test_only'
}
