import { createClient as createAdminClient, type SupabaseClient, type User } from '@supabase/supabase-js'

import { isAccountRole, canEditSettings, type AccountRole } from '@/lib/auth/roles'
import { createClient } from '@/lib/supabase/server'
import { WhatsAppTransportError } from '../types'

export interface OpenWASessionContext {
  user: User
  accountId: string
  accountRole: AccountRole
  userDb: SupabaseClient
  adminDb: SupabaseClient
}

export async function requireOpenWASessionAdmin(): Promise<OpenWASessionContext> {
  const userDb = await createClient()
  const { data: { user }, error: authError } = await userDb.auth.getUser()
  if (authError || !user) throw new WhatsAppTransportError('authentication_or_configuration', 'Unauthorized')

  const { data: profile, error: profileError } = await userDb
    .from('profiles')
    .select('account_id, account_role')
    .eq('user_id', user.id)
    .maybeSingle()

  const role = isAccountRole(profile?.account_role) ? profile.account_role : null
  if (profileError || !profile?.account_id || !role || !canEditSettings(role)) {
    throw new WhatsAppTransportError('authentication_or_configuration', 'Admin access is required for OpenWA session management', profileError)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) throw new WhatsAppTransportError('authentication_or_configuration', 'Server database credentials are not configured')

  const adminDb = createAdminClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  return { user, accountId: profile.account_id as string, accountRole: role, userDb, adminDb }
}
