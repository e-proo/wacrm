import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { checkCoverageSelectedContactEligibility } from '@/lib/services/coverage/selected-contact'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Search existing contacts in the current account, not a parallel recipient store.
 * Minimal fields only. Task runtime still enforces eligibility and all safety
 * policy before materializing the selected recipient.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireAgentCapability('agents.manage_tasks')
    const url = new URL(request.url)
    const raw = (url.searchParams.get('q') ?? '').trim()
    const contactId = url.searchParams.get('contactId')
    const requestId = url.searchParams.get('coverageRequestId')
    if (raw.length > 80 ||
        (contactId !== null && !UUID_RE.test(contactId)) ||
        (requestId !== null && !UUID_RE.test(requestId))) {
      return NextResponse.json({ error: 'بحث أو معرّف غير صالح.', code: 'INVALID_CONTACT_SEARCH' }, { status: 400 })
    }
    const db = supabaseAdmin()
    let query = db.from('contacts')
      .select('id,name,phone')
      .eq('account_id', ctx.accountId)

    if (contactId) {
      query = query.eq('id', contactId)
    } else if (raw) {
      // PostgREST's .or() expression must not accept commas, parentheses,
      // wildcard syntax or control characters from untrusted user input.
      const safe = raw.replace(/[^\p{L}\p{N} +@_-]/gu, '').trim()
      if (!safe) return NextResponse.json({ contacts: [], eligibility: null })
      query = query.or(`name.ilike.%${safe}%,phone.ilike.%${safe}%`)
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(contactId ? 1 : 50)
    if (error) throw error

    let eligibility: { eligible: boolean; reason?: string } | null = null
    if (contactId && requestId) {
      eligibility = await checkCoverageSelectedContactEligibility(db, {
        accountId: ctx.accountId, coverageRequestId: requestId, contactId,
      })
    }
    return NextResponse.json({
      contacts: (data ?? []).map((row) => ({
        id: row.id, name: row.name, phone: row.phone,
      })),
      eligibility,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
