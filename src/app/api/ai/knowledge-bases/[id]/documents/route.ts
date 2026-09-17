import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { addKnowledgeDocument, assertDynamicKnowledgeSource } from '@/lib/ai/knowledge-v2'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, source_type, source_uri, lifecycle_status, trust_level, language, effective_from, effective_until, injection_risk, reviewed_by, reviewed_at, created_at, updated_at')
      .eq('account_id', accountId)
      .eq('knowledge_base_id', id)
      .order('updated_at', { ascending: false })
    if (error) throw error
    return NextResponse.json({ documents: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb-doc:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body.title !== 'string' || typeof body.content !== 'string') {
      return NextResponse.json({ error: 'title and content are required' }, { status: 400 })
    }
    let sourceType
    try {
      sourceType = assertDynamicKnowledgeSource(typeof body.source_type === 'string' ? body.source_type : 'manual')
    } catch {
      return NextResponse.json({ error: 'Unsupported source_type. Repository/project files are not runtime knowledge sources.' }, { status: 400 })
    }
    const embeddings = await loadEmbeddingsKey(supabase, accountId)
    const created = await addKnowledgeDocument({
      db: supabase,
      accountId,
      userId,
      knowledgeBaseId: id,
      document: {
        title: body.title,
        content: body.content,
        sourceType,
        sourceUri: typeof body.source_uri === 'string' ? body.source_uri : null,
        trustLevel: body.trust_level === 'admin_verified' || body.trust_level === 'internal' || body.trust_level === 'external' || body.trust_level === 'untrusted' ? body.trust_level : undefined,
        language: typeof body.language === 'string' ? body.language : 'auto',
        effectiveFrom: typeof body.effective_from === 'string' ? body.effective_from : null,
        effectiveUntil: typeof body.effective_until === 'string' ? body.effective_until : null,
      },
      embedding: { embeddingsApiKey: embeddings.key, embeddingSetup: embeddings.embedSetup },
    })
    return NextResponse.json({ success: true, ...created }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
