import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { checkCoverageSelectedContactEligibility } from '@/lib/services/coverage/selected-contact'
import { MAX_EXPLICIT_COVERAGE_CONTACTS } from '@/lib/services/coverage/selected-targets'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { normalizeTestRecipient } from '@/lib/whatsapp/transport/openwa/pilot-recipient-input'

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
    const contactIdsValue = url.searchParams.get('contactIds')
    const contactIds = contactIdsValue === null
      ? null : contactIdsValue.split(',')
    const requestId = url.searchParams.get('coverageRequestId')
    if (raw.length > 80 ||
        (contactId !== null && !UUID_RE.test(contactId)) ||
        (contactIds !== null &&
          (contactId !== null || raw.length > 0 ||
           contactIds.length < 1 ||
           contactIds.length > MAX_EXPLICIT_COVERAGE_CONTACTS ||
           !contactIds.every(id => UUID_RE.test(id)) ||
           new Set(contactIds).size !== contactIds.length)) ||
        (requestId !== null && !UUID_RE.test(requestId))) {
      return NextResponse.json({ error: 'بحث أو معرّف غير صالح.', code: 'INVALID_CONTACT_SEARCH' }, { status: 400 })
    }
    const db = supabaseAdmin()
    let query = db.from('contacts')
      .select('id,name,phone')
      .eq('account_id', ctx.accountId)

    if (contactIds) {
      query = query.in('id', contactIds)
    } else if (contactId) {
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
      .limit(contactIds ? contactIds.length : contactId ? 1 : 50)
    if (error) throw error

    let eligibility: { eligible: boolean; reason?: string } | null = null
    let eligibilityById: Record<string, { eligible: boolean; reason?: string }> = {}
    if (contactIds && requestId) {
      const accountContacts = new Set((data ?? []).map(row => row.id))
      const verified = await Promise.all(contactIds.map(async id => [
        id,
        accountContacts.has(id)
          ? await checkCoverageSelectedContactEligibility(db, {
              accountId: ctx.accountId, coverageRequestId: requestId, contactId: id,
            })
          : { eligible: false, reason: 'contact_not_found' },
      ] as const))
      eligibilityById = Object.fromEntries(verified)
    }
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
      eligibilityById,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/**
 * Explicitly register a telephone-consented recipient as an ordinary
 * tenant-owned CRM contact, so the EXISTING Task pipeline (RLS, suppression,
 * idempotency, provider binding) remains the only execution path.
 * No WhatsApp message is sent by this endpoint.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAgentCapability('agents.manage_tasks')
    if (!isOpenWATestProject()) {
      return NextResponse.json({ error: 'TEST only' }, { status: 403 })
    }
    const body: unknown = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'بيانات غير صالحة.' }, { status: 400 })
    }
    const data = body as Record<string, unknown>
    const phone = typeof data.phone === 'string' ? normalizeTestRecipient(data.phone) : null
    const name = typeof data.name === 'string' ? data.name.trim() : ''
    if (!phone || !/^[1-9][0-9]{7,14}$/.test(phone) ||
        name.length > 80 || typeof data.coverageRequestId !== 'string' ||
        !UUID_RE.test(data.coverageRequestId) ||
        typeof data.whatsappConnectionId !== 'string' ||
        !UUID_RE.test(data.whatsappConnectionId) ||
        data.consent_method !== 'phone_call' ||
        data.whatsapp_opt_in_confirmed !== true) {
      return NextResponse.json({
        error: 'أدخل رقمًا دوليًا صحيحًا وأكد موافقة صاحبه صراحةً على التواصل عبر واتساب.',
        code: 'PHONE_CALL_CONSENT_REQUIRED',
      }, { status: 400 })
    }
    const db = supabaseAdmin()
    const [{ data: connection, error: connectionError },
      { data: source, error: sourceError }] = await Promise.all([
      db.from('whatsapp_connections')
        .select('id').eq('account_id', ctx.accountId)
        .eq('id', data.whatsappConnectionId).eq('provider', 'openwa')
        .in('status', ['ready','connected']).is('archived_at', null)
        .maybeSingle(),
      db.from('coverage_requests').select('id,requester_contact_id,status')
        .eq('account_id', ctx.accountId).eq('id', data.coverageRequestId)
        .in('status', ['active','partially_reserved']).maybeSingle(),
    ])
    if (connectionError || sourceError) throw connectionError ?? sourceError
    if (!connection || !source) {
      return NextResponse.json({
        error: 'اختر جلسة OpenWA وطلب تغطية نشطين في الحساب نفسه.',
      }, { status: 409 })
    }
    // Match BOTH normalized and older display-phone representations, so
    // conflicting account-owned identities cannot slip into a Task where
    // the OpenWA resolver would later refuse to dispatch.
    const [
      { data: normalized, error: normalizedError },
      { data: legacy, error: legacyError },
    ] = await Promise.all([
      db.from('contacts').select('id,name,phone').eq('account_id', ctx.accountId)
        .eq('phone_normalized', phone).limit(3),
      db.from('contacts').select('id,name,phone').eq('account_id', ctx.accountId)
        .in('phone', [phone, '+' + phone]).limit(3),
    ])
    if (normalizedError || legacyError) throw normalizedError ?? legacyError
    const matches = new Map(
      [...(normalized ?? []), ...(legacy ?? [])].map(row => [row.id, row]),
    )
    if (matches.size > 1) {
      return NextResponse.json({
        error: 'هناك أكثر من جهة اتصال للرقم نفسه ضمن الحساب. عالج التكرار قبل اعتماد المستهدف.',
        code: 'DUPLICATE_CONTACT_PHONE_IDENTITY',
      }, { status: 409 })
    }
    let contact = [...matches.values()][0] ?? null
    if (contact?.id === source.requester_contact_id) {
      return NextResponse.json({
        error: 'لا يمكن استهداف صاحب طلب التغطية نفسه.',
      }, { status: 409 })
    }
    if (!contact) {
      const { data: created, error: insertError } = await db.from('contacts')
        .insert({
          account_id: ctx.accountId, user_id: ctx.userId,
          phone: '+' + phone, phone_normalized: phone,
          name: name || null,
        })
        .select('id,name,phone').single()
      if (insertError) throw insertError
      contact = created
    }
    return NextResponse.json({
      contact, registered: true,
      message: 'تم إتاحة الرقم للاختيار داخل المهمة؛ لم تُرسل رسالة.',
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
