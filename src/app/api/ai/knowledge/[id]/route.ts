import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { classifyKnowledgeInjectionRisk } from '@/lib/ai/knowledge-v2'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('ai_knowledge_documents')
      .select('id, knowledge_base_id, title, content, source_type, lifecycle_status, trust_level, language, injection_risk, updated_at')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(data)
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const body = await request.json().catch(() => null) as { title?: unknown; content?: unknown } | null
    const title = typeof body?.title === 'string' ? body.title.trim() : undefined
    const content = typeof body?.content === 'string' ? body.content.trim() : undefined
    if (title === undefined && content === undefined) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }
    if (title !== undefined && !title) return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 })
    if (content !== undefined && !content) return NextResponse.json({ error: 'content cannot be empty' }, { status: 400 })

    const update: Record<string, unknown> = {}
    if (title !== undefined) update.title = title
    if (content !== undefined) {
      update.content = content
      update.injection_risk = classifyKnowledgeInjectionRisk(content)
      // Editing factual content invalidates the previous human review.
      update.lifecycle_status = update.injection_risk === 'high' ? 'quarantined' : 'draft'
      update.reviewed_by = null
      update.reviewed_at = null
      update.review_notes = null
    }
    const { data: updated, error } = await supabase
      .from('ai_knowledge_documents')
      .update(update)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id, lifecycle_status, injection_risk')
      .maybeSingle()
    if (error) throw error
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    let indexingWarning: string | null = null
    if (content !== undefined) {
      const embeddings = await loadEmbeddingsKey(supabase, accountId)
      try {
        await ingestDocument(
          supabase,
          accountId,
          { embeddingsApiKey: embeddings.key, embeddingSetup: embeddings.embedSetup },
          id,
          content,
        )
      } catch (err) {
        indexingWarning = err instanceof Error ? err.message : 'indexing failed'
      }
    }
    return NextResponse.json({ success: true, ...updated, warning: indexingWarning, requires_review: content !== undefined })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { id } = await params
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase
      .from('ai_knowledge_documents')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
