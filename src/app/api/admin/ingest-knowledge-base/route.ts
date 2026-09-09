// ============================================================
// POST /api/admin/ingest-knowledge-base
//
// One-shot: ingests every knowledge-base/*.md file (shipped with
// the repo) into the account's AI knowledge base via the SAME
// ingestDocument path the Setup UI uses — chunking + optional
// semantic indexing. Idempotent per title: existing documents with
// the same title are UPDATED (content refreshed, chunks rebuilt).
//
// Optionally assigns every resulting chunk to the given agent
// (body: { agentId }) — the "inherit whole KB" step in one call.
//
// Admin+ only. Requires the knowledge-base/ directory present in
// the deployment (it ships with the repo).
// ============================================================

import fs from 'fs'
import path from 'path'
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { supabaseAdmin } from '@/lib/ai/admin-client'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:ingestKB:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => ({}))) as {
      agentId?: string
    }

    // knowledge-base lives at the repo root — resolve relative to
    // the compiled route (cwd is the project root in every deploy
    // mode this template supports).
    const kbDir = path.join(process.cwd(), 'knowledge-base')
    if (!fs.existsSync(kbDir)) {
      return NextResponse.json(
        { error: 'knowledge-base directory not found in this deployment' },
        { status: 404 },
      )
    }

    const files = fs
      .readdirSync(kbDir)
      .filter(
        (f) =>
          f.toLowerCase().endsWith('.md') &&
          f.toLowerCase() !== 'readme.md',
      )
    if (files.length === 0) {
      return NextResponse.json(
        { error: 'No .md files to ingest' },
        { status: 404 },
      )
    }

    const db = supabaseAdmin()
    const { key: embeddingsApiKey, embedSetup, corrupt } = await loadEmbeddingsKey(
      db,
      ctx.accountId,
    )
    void corrupt

    const results: Array<{
      title: string
      documentId: string
      action: 'created' | 'updated'
      indexed: boolean
      warning?: string
    }> = []

    for (const file of files) {
      const title = file
        .replace(/\.md$/i, '')
        .replace(/^\d+-/, '')
        .replace(/[-_]/g, ' ')
        .trim()
      const content = fs
        .readFileSync(path.join(kbDir, file), 'utf8')
        .trim()
      if (!content) continue

      // Idempotent per title: update the content of an existing doc
      // so re-running refreshes chunks instead of duplicating.
      const { data: existing } = await db
        .from('ai_knowledge_documents')
        .select('id')
        .eq('account_id', ctx.accountId)
        .eq('title', title)
        .maybeSingle()

      let documentId: string
      let action: 'created' | 'updated'
      if (existing) {
        documentId = (existing as { id: string }).id
        await db
          .from('ai_knowledge_documents')
          .update({ content })
          .eq('id', documentId)
        action = 'updated'
      } else {
        const { data: doc, error: docError } = await db
          .from('ai_knowledge_documents')
          .insert({
            account_id: ctx.accountId,
            created_by: ctx.userId,
            title,
            content,
          })
          .select('id')
          .single()
        if (docError || !doc) throw docError
        documentId = (doc as { id: string }).id
        action = 'created'
      }

      let indexed = true
      let warning: string | undefined
      try {
        await ingestDocument(
          db,
          ctx.accountId,
          { embeddingsApiKey, embeddingSetup: embedSetup },
          documentId,
          content,
        )
      } catch (err) {
        indexed = false
        warning =
          err instanceof Error
            ? `lexical-only (${err.message})`
            : 'lexical-only (indexing failed)'
      }
      results.push({ title, documentId, action, indexed, warning })
    }

    // Optional: assign all chunks to the given agent's latest
    // revision (inherit whole KB in the same call).
    let assigned = 0
    if (body.agentId) {
      const { data: rev } = await db
        .from('ai_agent_revisions')
        .select('id, revision_number')
        .eq('account_id', ctx.accountId)
        .eq('agent_id', body.agentId)
        .order('revision_number', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (rev) {
        const revisionId = (rev as { id: string }).id
        const { data: chunks } = await db
          .from('ai_knowledge_chunks')
          .select('id')
          .eq('account_id', ctx.accountId)
        const { data: existingAssignments } = await db
          .from('ai_agent_knowledge_assignments')
          .select('knowledge_chunk_id')
          .eq('account_id', ctx.accountId)
          .eq('agent_revision_id', revisionId)
        const have = new Set(
          (existingAssignments ?? []).map(
            (e) => (e as { knowledge_chunk_id: string }).knowledge_chunk_id,
          ),
        )
        const missing = (chunks ?? [])
          .map((c) => (c as { id: string }).id)
          .filter((chunkId) => !have.has(chunkId))
        if (missing.length > 0) {
          const { error: insError } = await db
            .from('ai_agent_knowledge_assignments')
            .insert(
              missing.map((chunkId) => ({
                account_id: ctx.accountId,
                agent_revision_id: revisionId,
                knowledge_chunk_id: chunkId,
                enabled: true,
                priority: 100,
              })),
            )
          if (insError) throw insError
        }
        assigned = missing.length
      }
    }

    return NextResponse.json({
      success: true,
      ingested: results.length,
      results,
      assignedToRevision: assigned,
      note: corrupt
        ? 'Embeddings key could not be decrypted — lexical search only.'
        : undefined,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
