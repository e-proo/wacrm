import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
/** Agent-readable safe metadata only, no session credentials or secrets. */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { data, error } = await supabase.from('whatsapp_connections')
      .select('id,provider,display_name,status').eq('account_id', accountId)
      .is('archived_at', null).in('status', ['connected', 'ready'])
      .order('created_at', { ascending: true })
    if (error) throw error
    const connections = (data ?? [])
      .filter((row) => row.provider === 'meta_cloud' || row.provider === 'openwa')
      .map((row) => ({
        id: row.id, provider: row.provider,
        name: row.display_name || (row.provider === 'meta_cloud' ? 'Meta Cloud API' : 'OpenWA session'),
      }))
    return NextResponse.json({ connections }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
