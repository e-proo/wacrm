import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { setKnowledgeDocumentLifecycle } from '@/lib/ai/knowledge-v2'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; documentId: string }> },
) {
  try {
    const { id, documentId } = await params
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb-doc-review:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    const status = body?.status
    if (status !== 'reviewed' && status !== 'active' && status !== 'archived' && status !== 'quarantined') {
      return NextResponse.json({ error: 'status must be reviewed, active, archived, or quarantined' }, { status: 400 })
    }

    // Bind document to the requested KB as well as the account. This prevents
    // a guessed document UUID from being reviewed through another KB route.
    const { data: document, error } = await supabase
      .from('ai_knowledge_documents')
      .select('id')
      .eq('account_id', accountId)
      .eq('knowledge_base_id', id)
      .eq('id', documentId)
      .maybeSingle()
    if (error) throw error
    if (!document) return NextResponse.json({ error: 'Document not found' }, { status: 404 })

    await setKnowledgeDocumentLifecycle({
      db: supabase,
      accountId,
      documentId,
      userId,
      status,
      reviewNotes: typeof body?.review_notes === 'string' ? body.review_notes : null,
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
