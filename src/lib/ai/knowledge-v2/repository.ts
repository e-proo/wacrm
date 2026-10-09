import type { SupabaseClient } from '@supabase/supabase-js'
import { ingestDocument } from '../knowledge'
import type { KnowledgeEmbeddingContext } from './retrieval'
import {
  assertDynamicKnowledgeSource,
  classifyKnowledgeInjectionRisk,
  initialLifecycleForSource,
  normalizeTrustLevel,
} from './security'
import type {
  KnowledgeBaseScope,
  KnowledgeBaseStatus,
  KnowledgeDocumentInput,
  KnowledgeTrustLevel,
} from './types'

export function slugifyKnowledgeBaseName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug || `kb-${Date.now().toString(36)}`
}

export async function createKnowledgeBase(input: {
  db: SupabaseClient
  accountId: string
  userId: string
  name: string
  slug?: string
  description?: string | null
  scope?: KnowledgeBaseScope
  ownerAgentId?: string | null
  defaultTrustLevel?: KnowledgeTrustLevel
}): Promise<{ id: string; slug: string }> {
  const name = input.name.trim()
  if (!name) throw new Error('KNOWLEDGE_BASE_NAME_REQUIRED')
  const scope = input.scope ?? 'shared'
  if (scope === 'agent_private' && !input.ownerAgentId) {
    throw new Error('AGENT_PRIVATE_KB_REQUIRES_OWNER_AGENT')
  }
  const slug = input.slug?.trim() || slugifyKnowledgeBaseName(name)
  const { data, error } = await input.db
    .from('ai_knowledge_bases')
    .insert({
      account_id: input.accountId,
      name,
      slug,
      description: input.description?.trim() || null,
      scope,
      owner_agent_id: input.ownerAgentId ?? null,
      status: 'draft',
      default_trust_level: input.defaultTrustLevel ?? 'internal',
      created_by: input.userId,
      updated_by: input.userId,
    })
    .select('id, slug')
    .single()
  if (error || !data) throw error ?? new Error('KNOWLEDGE_BASE_CREATE_FAILED')
  return data as { id: string; slug: string }
}

export async function addKnowledgeDocument(input: {
  db: SupabaseClient
  accountId: string
  userId: string
  knowledgeBaseId: string
  document: KnowledgeDocumentInput
  embedding: KnowledgeEmbeddingContext
}): Promise<{
  id: string
  lifecycleStatus: string
  injectionRisk: string
  indexingWarning: string | null
}> {
  const sourceType = assertDynamicKnowledgeSource(input.document.sourceType)
  const title = input.document.title.trim()
  const content = input.document.content.trim()
  if (!title || !content) throw new Error('KNOWLEDGE_DOCUMENT_TITLE_CONTENT_REQUIRED')

  const { data: base, error: baseError } = await input.db
    .from('ai_knowledge_bases')
    .select('id, default_trust_level')
    .eq('account_id', input.accountId)
    .eq('id', input.knowledgeBaseId)
    .maybeSingle()
  if (baseError) throw baseError
  if (!base) throw new Error('KNOWLEDGE_BASE_NOT_FOUND')

  const fallbackTrust = normalizeTrustLevel(base.default_trust_level, 'internal')
  const trustLevel = normalizeTrustLevel(input.document.trustLevel, fallbackTrust)
  const injectionRisk = classifyKnowledgeInjectionRisk(content)
  const lifecycleStatus = initialLifecycleForSource({ sourceType, trustLevel, injectionRisk })

  const { data: doc, error } = await input.db
    .from('ai_knowledge_documents')
    .insert({
      account_id: input.accountId,
      knowledge_base_id: input.knowledgeBaseId,
      created_by: input.userId,
      title,
      content,
      source_type: sourceType,
      source_uri: input.document.sourceUri?.trim() || null,
      lifecycle_status: lifecycleStatus,
      trust_level: trustLevel,
      language: input.document.language?.trim() || 'auto',
      effective_from: input.document.effectiveFrom ?? null,
      effective_until: input.document.effectiveUntil ?? null,
      injection_risk: injectionRisk,
    })
    .select('id')
    .single()
  if (error || !doc) throw error ?? new Error('KNOWLEDGE_DOCUMENT_CREATE_FAILED')

  let indexingWarning: string | null = null
  try {
    await ingestDocument(
      input.db,
      input.accountId,
      input.embedding,
      doc.id,
      content,
    )
  } catch (err) {
    // Lexical insert is best-effort in the legacy ingest helper. Preserve the
    // document and let admin retry indexing; never auto-activate it.
    indexingWarning = err instanceof Error ? err.message : 'indexing failed'
  }

  return { id: doc.id, lifecycleStatus, injectionRisk, indexingWarning }
}

export async function setKnowledgeDocumentLifecycle(input: {
  db: SupabaseClient
  accountId: string
  documentId: string
  userId: string
  status: 'reviewed' | 'active' | 'archived' | 'quarantined'
  reviewNotes?: string | null
}): Promise<void> {
  const { data: current, error: currentError } = await input.db
    .from('ai_knowledge_documents')
    .select('id, lifecycle_status, injection_risk, reviewed_at, reviewed_by, review_notes')
    .eq('account_id', input.accountId)
    .eq('id', input.documentId)
    .maybeSingle()
  if (currentError) throw currentError
  if (!current) throw new Error('KNOWLEDGE_DOCUMENT_NOT_FOUND')

  const row = current as {
    lifecycle_status: string
    injection_risk: string
    reviewed_at: string | null
    reviewed_by: string | null
    review_notes: string | null
  }

  if (input.status === 'active' && row.lifecycle_status !== 'reviewed') {
    throw new Error('KNOWLEDGE_DOCUMENT_MUST_BE_REVIEWED_BEFORE_ACTIVATION')
  }

  const reviewNotes = input.reviewNotes?.trim().slice(0, 2000) || null
  if (input.status === 'reviewed' && row.injection_risk === 'high' && !reviewNotes) {
    throw new Error('HIGH_RISK_KNOWLEDGE_REVIEW_NOTES_REQUIRED')
  }

  const update: Record<string, unknown> = { lifecycle_status: input.status }
  if (input.status === 'reviewed') {
    update.reviewed_by = input.userId
    update.reviewed_at = new Date().toISOString()
    update.review_notes = reviewNotes
  } else if (input.status === 'quarantined' && reviewNotes) {
    update.review_notes = reviewNotes
  }

  const { error } = await input.db
    .from('ai_knowledge_documents')
    .update(update)
    .eq('account_id', input.accountId)
    .eq('id', input.documentId)
  if (error) throw error
}

export async function setKnowledgeBaseStatus(input: {
  db: SupabaseClient
  accountId: string
  knowledgeBaseId: string
  userId: string
  status: KnowledgeBaseStatus
}): Promise<void> {
  const { error } = await input.db
    .from('ai_knowledge_bases')
    .update({ status: input.status, updated_by: input.userId })
    .eq('account_id', input.accountId)
    .eq('id', input.knowledgeBaseId)
  if (error) throw error
}

/**
 * Compatibility helper for the pre-v2 /api/ai/knowledge endpoint.
 * New UI should let admins choose/create a KB explicitly, but legacy callers
 * are mapped into a normal dynamic shared KB instead of creating unscoped
 * documents. Nothing is loaded from repository files.
 */
export async function ensureGeneralKnowledgeBase(input: {
  db: SupabaseClient
  accountId: string
  userId: string
}): Promise<{ id: string; status: KnowledgeBaseStatus }> {
  const existing = await input.db
    .from('ai_knowledge_bases')
    .select('id, status')
    .eq('account_id', input.accountId)
    .eq('slug', 'general')
    .maybeSingle()
  if (existing.error) throw existing.error
  if (existing.data) return existing.data as { id: string; status: KnowledgeBaseStatus }

  const { data, error } = await input.db
    .from('ai_knowledge_bases')
    .insert({
      account_id: input.accountId,
      name: 'General knowledge',
      slug: 'general',
      description: 'Shared dynamic knowledge created for legacy knowledge API compatibility.',
      scope: 'shared',
      status: 'draft',
      default_trust_level: 'internal',
      created_by: input.userId,
      updated_by: input.userId,
    })
    .select('id, status')
    .single()
  if (error || !data) {
    // A concurrent request may have created it after our initial read.
    const retry = await input.db
      .from('ai_knowledge_bases')
      .select('id, status')
      .eq('account_id', input.accountId)
      .eq('slug', 'general')
      .maybeSingle()
    if (retry.error || !retry.data) throw error ?? retry.error ?? new Error('GENERAL_KB_CREATE_FAILED')
    return retry.data as { id: string; status: KnowledgeBaseStatus }
  }
  return data as { id: string; status: KnowledgeBaseStatus }
}
