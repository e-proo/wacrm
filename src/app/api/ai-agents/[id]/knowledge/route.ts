// ============================================================
// GET  /api/ai-agents/[id]/knowledge — account chunks + per-
//       revision assignment state (admin+).
// PUT  — REPLACE assignments for one revision (admin+).
// POST /sync — assign every account chunk to the latest draft
//       revision (the "inherit whole KB" shortcut).
// ============================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'

interface RouteContext {
  params: Promise<{ id: string }>
}

async function loadLatestRevision(
  supabase: SupabaseClient,
  accountId: string,
  agentId: string,
): Promise<{ id: string; status: string } | null> {
  // Latest draft first, else latest published.
  const { data: draft } = await supabase
    .from('ai_agent_revisions')
    .select('id, status')
    .eq('account_id', accountId)
    .eq('agent_id', agentId)
    .eq('status', 'draft')
    .order('revision_number', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (draft) return draft as { id: string; status: string }
  const { data: any } = await supabase
    .from('ai_agent_revisions')
    .select('id, status')
    .eq('account_id', accountId)
    .eq('agent_id', agentId)
    .order('revision_number', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (any as { id: string; status: string } | null) ?? null
}

export async function GET(
  _request: Request,
  { params }: RouteContext,
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:agentKnowledge:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params

    const revision = await loadLatestRevision(ctx.supabase, ctx.accountId, id)
    const [chunksRes, assignmentsRes] = await Promise.all([
      ctx.supabase
        .from('ai_knowledge_chunks')
        .select('id, chunk_index, content, document_id')
        .eq('account_id', ctx.accountId)
        .order('document_id', { ascending: true })
        .order('chunk_index', { ascending: true }),
      revision
        ? ctx.supabase
            .from('ai_agent_knowledge_assignments')
            .select('knowledge_chunk_id, priority, enabled')
            .eq('account_id', ctx.accountId)
            .eq('agent_revision_id', revision.id)
        : Promise.resolve({ data: [], error: null }),
    ])
    if (chunksRes.error) throw chunksRes.error
    if (assignmentsRes.error) throw assignmentsRes.error

    const assigned = new Map(
      ((assignmentsRes.data ?? []) as Array<{
        knowledge_chunk_id: string
        priority: number
        enabled: boolean
      }>).map((a) => [a.knowledge_chunk_id, a]),
    )

    return NextResponse.json({
      revision,
      chunks: (chunksRes.data ?? []).map((row) => {
        const r = row as {
          id: string
          chunk_index: number
          content: string
          document_id: string
        }
        const assignment = assigned.get(r.id)
        return {
          chunk_id: r.id,
          document_id: r.document_id,
          chunk_index: r.chunk_index,
          preview: r.content.slice(0, 160),
          assigned: Boolean(assignment),
          enabled: assignment?.enabled ?? false,
          priority: assignment?.priority ?? 100,
        }
      }),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(
  request: Request,
  { params }: RouteContext,
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:agentKnowledgeWrite:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params

    const body = (await request.json()) as {
      revisionId?: string
      assignments?: Array<{ chunk_id: string; enabled: boolean; priority?: number }>
    }
    if (!body.revisionId || !Array.isArray(body.assignments)) {
      return NextResponse.json(
        { error: 'revisionId and assignments are required' },
        { status: 400 },
      )
    }
    // Verify the revision belongs to this account + agent.
    const { data: rev } = await ctx.supabase
      .from('ai_agent_revisions')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('agent_id', id)
      .eq('id', body.revisionId)
      .maybeSingle()
    if (!rev) {
      return NextResponse.json({ error: 'Revision not found' }, { status: 404 })
    }

    const db = supabaseAdmin()
    const { error: delError } = await db
      .from('ai_agent_knowledge_assignments')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('agent_revision_id', body.revisionId)
    if (delError) throw delError
    const valid = body.assignments.filter(
      (a) => a.chunk_id && a.enabled,
    )
    if (valid.length > 0) {
      const { error: insError } = await db
        .from('ai_agent_knowledge_assignments')
        .insert(
          valid.map((a) => ({
            account_id: ctx.accountId,
            agent_revision_id: body.revisionId,
            knowledge_chunk_id: a.chunk_id,
            enabled: true,
            priority: a.priority ?? 100,
          })),
        )
      if (insError) throw insError
    }
    // Mark this draft's KB scope as INITIALIZED by the admin. The
    // publish flow otherwise re-seeds an assignment-less draft from
    // the superseded revision — without this flag a deliberate
    // "unbind everything" could never persist (publish resurrected
    // the removed chunks).
    const { data: revRow } = await db
      .from('ai_agent_revisions')
      .select('settings')
      .eq('account_id', ctx.accountId)
      .eq('id', body.revisionId)
      .maybeSingle()
    const { error: markErr } = await db
      .from('ai_agent_revisions')
      .update({
        settings: {
          ...(((revRow as { settings?: Record<string, unknown> } | null)?.settings) ?? {}),
          kb_assignments_initialized: true,
        },
      })
      .eq('account_id', ctx.accountId)
      .eq('id', body.revisionId)
    if (markErr) throw markErr
    return NextResponse.json({ ok: true, assigned: valid.length })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(
  _request: Request,
  { params }: RouteContext,
) {
  // Sync: assign every account chunk to the agent's latest revision
  // (the "inherit whole KB" shortcut — per plan the default system
  // agent inherits the account knowledge base).
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:agentKnowledgeSync:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params

    const revision = await loadLatestRevision(ctx.supabase, ctx.accountId, id)
    if (!revision) {
      return NextResponse.json({ error: 'Revision not found' }, { status: 404 })
    }
    const db = supabaseAdmin()
    const { data: chunks, error: chunksError } = await db
      .from('ai_knowledge_chunks')
      .select('id')
      .eq('account_id', ctx.accountId)
    if (chunksError) throw chunksError
    const { data: existing } = await db
      .from('ai_agent_knowledge_assignments')
      .select('knowledge_chunk_id')
      .eq('account_id', ctx.accountId)
      .eq('agent_revision_id', revision.id)
    const have = new Set((existing ?? []).map((e) => (e as { knowledge_chunk_id: string }).knowledge_chunk_id))
    const missing = (chunks ?? [])
      .map((c) => (c as { id: string }).id)
      .filter((chunkId) => !have.has(chunkId))
    if (missing.length > 0) {
      const { error: insError } = await db
        .from('ai_agent_knowledge_assignments')
        .insert(
          missing.map((chunkId) => ({
            account_id: ctx.accountId,
            agent_revision_id: revision.id,
            knowledge_chunk_id: chunkId,
            enabled: true,
            priority: 100,
          })),
        )
      if (insError) throw insError
    }
    return NextResponse.json({ ok: true, synced: missing.length, total: (chunks ?? []).length })
  } catch (err) {
    return toErrorResponse(err)
  }
}
