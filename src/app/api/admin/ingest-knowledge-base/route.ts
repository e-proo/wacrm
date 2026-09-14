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

import type { SupabaseClient } from '@supabase/supabase-js'

// ------------------------------------------------------------
// Binding preservation across a re-ingest.
//
// ingestDocument REPLACES every chunk row (new uuids) and the
// ai_agent_knowledge_assignments cascade-delete with them. A
// snapshot/restore keyed by chunk_index — stable only across an
// IDENTICAL or same-count rebuild — means agents keep their KB
// bound without waiting for the final blanket assign pass. When the
// document was RE-SPLIT (chunk count changed) the positional key is
// wrong: index N no longer points at the same text, so bindings are
// skipped (and the admin is warned) rather than silently rebound to
// the wrong chunks.
// ------------------------------------------------------------

interface BindingSnapshot {
  agent_revision_id: string
  chunk_index: number
  priority: number
  enabled: boolean
}

interface DocumentBindingSnapshot {
  bindings: BindingSnapshot[]
  chunkCount: number
}

async function snapshotDocumentBindings(
  db: SupabaseClient,
  accountId: string,
  documentId: string,
): Promise<DocumentBindingSnapshot> {
  const { data: chunks } = await db
    .from('ai_knowledge_chunks')
    .select('id, chunk_index')
    .eq('account_id', accountId)
    .eq('document_id', documentId)
  const rows = (chunks ?? []) as Array<{ id: string; chunk_index: number }>
  if (rows.length === 0) return { bindings: [], chunkCount: 0 }
  const indexById = new Map(rows.map((c) => [c.id, c.chunk_index]))
  const { data: bindings } = await db
    .from('ai_agent_knowledge_assignments')
    .select('agent_revision_id, knowledge_chunk_id, priority, enabled')
    .eq('account_id', accountId)
  return {
    chunkCount: rows.length,
    bindings: ((bindings ?? []) as Array<{
      agent_revision_id: string
      knowledge_chunk_id: string
      priority: number
      enabled: boolean
    }>)
      .filter((b) => indexById.has(b.knowledge_chunk_id))
      .map((b) => ({
        agent_revision_id: b.agent_revision_id,
        chunk_index: indexById.get(b.knowledge_chunk_id) as number,
        priority: b.priority,
        enabled: b.enabled,
      })),
  }
}

async function restoreDocumentBindings(
  db: SupabaseClient,
  accountId: string,
  documentId: string,
  snapshot: DocumentBindingSnapshot,
): Promise<string | undefined> {
  if (snapshot.bindings.length === 0) return undefined
  const { data: chunks } = await db
    .from('ai_knowledge_chunks')
    .select('id, chunk_index')
    .eq('account_id', accountId)
    .eq('document_id', documentId)
  const newRows = (chunks ?? []) as Array<{ id: string; chunk_index: number }>
  if (newRows.length !== snapshot.chunkCount) {
    // The content was re-split: chunk_index no longer identifies
    // the same text, so a positional restore would bind agents to
    // the WRONG chunks. Skip loudly instead.
    return `bindings-not-restored (${snapshot.chunkCount} chunks before re-ingest, ${newRows.length} after — re-check the agent's knowledge assignments)`
  }
  const idByIndex = new Map(
    newRows.map((c) => [c.chunk_index, c.id]),
  )
  const rows = snapshot.bindings
    .filter((b) => idByIndex.has(b.chunk_index))
    .map((b) => ({
      account_id: accountId,
      agent_revision_id: b.agent_revision_id,
      knowledge_chunk_id: idByIndex.get(b.chunk_index) as string,
      priority: b.priority,
      enabled: b.enabled,
    }))
  if (rows.length === 0) return undefined
  const { error } = await db
    .from('ai_agent_knowledge_assignments')
    .upsert(rows, {
      onConflict: 'agent_revision_id,knowledge_chunk_id',
    })
  if (error) {
    console.error(
      '[ingest-knowledge-base] restore bindings failed:',
      error,
    )
    return `bindings-not-restored (${error.message})`
  }
  return undefined
}

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
      // Re-ingest REPLACES every chunk row (new uuids) and the agent
      // bindings cascade-delete with them. Snapshot this document's
      // bindings first (by chunk_index — only trustworthy when the
      // rebuild keeps the same chunk count) and restore them
      // afterwards, so an identical re-ingest never silently
      // unbinds the KB from a revision.
      const snapshot = await snapshotDocumentBindings(
        db,
        ctx.accountId,
        documentId,
      )
      try {
        await ingestDocument(
          db,
          ctx.accountId,
          { embeddingsApiKey, embeddingSetup: embedSetup },
          documentId,
          content,
        )
        const restoreWarning = await restoreDocumentBindings(
          db,
          ctx.accountId,
          documentId,
          snapshot,
        )
        warning = restoreWarning
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
