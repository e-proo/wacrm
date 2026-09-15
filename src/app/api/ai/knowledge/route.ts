import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { addKnowledgeDocument, ensureGeneralKnowledgeBase } from '@/lib/ai/knowledge-v2'

/**
 * Compatibility facade for the old single-list knowledge UI.
 *
 * The runtime no longer has a global account KB fallback. New code should use
 * /api/ai/knowledge-bases. This endpoint maps legacy manual entries into the
 * dynamic shared "general" KB and always leaves new content in review state.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, updated_at, lifecycle_status, knowledge_base_id, ai_knowledge_bases(name, slug, status)')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false })
    if (error) throw error
    return NextResponse.json({ documents: data ?? [], deprecated_single_base_api: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const body = await request.json().catch(() => null) as { title?: unknown; content?: unknown } | null
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!title || !content) {
      return NextResponse.json({ error: 'title and content are required' }, { status: 400 })
    }

    const base = await ensureGeneralKnowledgeBase({ db: supabase, accountId, userId })
    const embeddings = await loadEmbeddingsKey(supabase, accountId)
    const created = await addKnowledgeDocument({
      db: supabase,
      accountId,
      userId,
      knowledgeBaseId: base.id,
      document: { title, content, sourceType: 'manual', trustLevel: 'internal', language: 'auto' },
      embedding: { embeddingsApiKey: embeddings.key, embeddingSetup: embeddings.embedSetup },
    })

    return NextResponse.json({
      success: true,
      id: created.id,
      knowledge_base_id: base.id,
      lifecycle_status: created.lifecycleStatus,
      injection_risk: created.injectionRisk,
      warning: created.indexingWarning,
      requires_review: true,
      deprecated_single_base_api: true,
    }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
