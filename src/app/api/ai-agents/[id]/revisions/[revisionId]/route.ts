// ============================================================
// /api/ai-agents/[id]/revisions/[revisionId]
//
// GET    — full settings of one revision.
// PATCH  — edit the DRAFT revision (published rows are immutable).
// DELETE — discard the DRAFT revision (grants + knowledge
//          assignments cascade via FK).
//
// Admin+ only.
// ============================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

export const REVISION_SELECT =
  'id, account_id, agent_id, revision_number, status, provider_connection_id, model, system_prompt, response_style, language_policy, temperature, max_output_tokens, max_tool_rounds, max_ai_replies_per_conversation, handoff_human_member_id, settings, created_at, published_at, rejection_reason'

interface UpdateBody {
  providerConnectionId?: string | null
  model?: string
  systemPrompt?: string | null
  responseStyle?: string
  languagePolicy?: string
  temperature?: number | null
  maxOutputTokens?: number | null
  maxToolRounds?: number
  maxAiRepliesPerConversation?: number
  handoffHumanMemberId?: string | null
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; revisionId: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:aiRevisionGet:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id, revisionId } = await params
    const { data, error } = await ctx.supabase
      .from('ai_agent_revisions')
      .select(REVISION_SELECT)
      .eq('account_id', ctx.accountId)
      .eq('agent_id', id)
      .eq('id', revisionId)
      .maybeSingle()
    if (error) throw error
    if (!data) return NextResponse.json({ error: 'Revision not found' }, { status: 404 })
    return NextResponse.json({ revision: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

async function loadDraft(
  ctx: { accountId: string; supabase: SupabaseClient },
  agentId: string,
  revisionId: string,
) {
  const { data: revision, error } = await ctx.supabase
    .from('ai_agent_revisions')
    .select('id, status')
    .eq('account_id', ctx.accountId)
    .eq('agent_id', agentId)
    .eq('id', revisionId)
    .maybeSingle()
  if (error) throw error
  if (!revision) {
    return { revision: null, conflict: NextResponse.json({ error: 'Revision not found' }, { status: 404 }) }
  }
  if ((revision as { status: string }).status !== 'draft') {
    return {
      revision,
      conflict: NextResponse.json(
        { error: 'Only draft revisions can be edited or discarded.', code: 'REVISION_NOT_DRAFT' },
        { status: 409 },
      ),
    }
  }
  return { revision, conflict: null }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; revisionId: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:aiRevisionPatch:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id, revisionId } = await params

    const { conflict } = await loadDraft(ctx, id, revisionId)
    if (conflict) return conflict

    let body: UpdateBody
    try {
      body = (await request.json()) as UpdateBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const update: Record<string, unknown> = {}
    if (body.providerConnectionId !== undefined) {
      update.provider_connection_id = body.providerConnectionId === '' ? null : body.providerConnectionId
    }
    if (body.model !== undefined) {
      update.model = (body.model ?? '').trim().slice(0, 120)
    }
    if (body.systemPrompt !== undefined) {
      const p = body.systemPrompt === null ? null : String(body.systemPrompt)
      if (p !== null && p.length > 8000) {
        return NextResponse.json({ error: 'systemPrompt is too long (max 8000 chars)' }, { status: 400 })
      }
      update.system_prompt = p
    }
    if (body.responseStyle !== undefined) {
      if (!['concise', 'balanced', 'detailed'].includes(body.responseStyle)) {
        return NextResponse.json({ error: 'responseStyle must be concise, balanced or detailed' }, { status: 400 })
      }
      update.response_style = body.responseStyle
    }
    if (body.languagePolicy !== undefined) {
      if (typeof body.languagePolicy !== 'string' || !/^[a-z-]{2,12}$/.test(body.languagePolicy)) {
        return NextResponse.json({ error: 'languagePolicy must be a short code like "auto" or "ar"' }, { status: 400 })
      }
      update.language_policy = body.languagePolicy
    }
    if (body.temperature !== undefined) {
      if (body.temperature !== null && (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 2)) {
        return NextResponse.json({ error: 'temperature must be between 0 and 2' }, { status: 400 })
      }
      update.temperature = body.temperature
    }
    if (body.maxOutputTokens !== undefined) {
      // 045 keeps ai_agent_revisions.max_output_tokens between 1 and
      // 32000 — a wider value passes here only to die as an opaque
      // CHECK violation in Postgres.
      if (body.maxOutputTokens !== null && (!Number.isInteger(body.maxOutputTokens) || body.maxOutputTokens < 16 || body.maxOutputTokens > 32000)) {
        return NextResponse.json({ error: 'maxOutputTokens must be 16-32000' }, { status: 400 })
      }
      update.max_output_tokens = body.maxOutputTokens
    }
    if (body.maxToolRounds !== undefined) {
      if (!Number.isInteger(body.maxToolRounds) || body.maxToolRounds < 0 || body.maxToolRounds > 10) {
        return NextResponse.json({ error: 'maxToolRounds must be 0-10' }, { status: 400 })
      }
      update.max_tool_rounds = body.maxToolRounds
    }
    if (body.maxAiRepliesPerConversation !== undefined) {
      if (!Number.isInteger(body.maxAiRepliesPerConversation) || body.maxAiRepliesPerConversation < 1 || body.maxAiRepliesPerConversation > 20) {
        return NextResponse.json({ error: 'maxAiRepliesPerConversation must be 1-20' }, { status: 400 })
      }
      update.max_ai_replies_per_conversation = body.maxAiRepliesPerConversation
    }
    if (body.handoffHumanMemberId !== undefined) {
      update.handoff_human_member_id = body.handoffHumanMemberId === '' ? null : body.handoffHumanMemberId
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'No fields supplied' }, { status: 400 })
    }

    const { data, error } = await ctx.supabase
      .from('ai_agent_revisions')
      .update(update)
      .eq('account_id', ctx.accountId)
      .eq('agent_id', id)
      .eq('id', revisionId)
      .eq('status', 'draft')
      .select(REVISION_SELECT)
      .single()
    if (error || !data) {
      console.error('[PATCH ai agents revision] failed:', error)
      return NextResponse.json({ error: 'Failed to update revision' }, { status: 500 })
    }
    return NextResponse.json({ revision: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; revisionId: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:aiRevisionDelete:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id, revisionId } = await params

    const { conflict } = await loadDraft(ctx, id, revisionId)
    if (conflict) return conflict

    const { error } = await ctx.supabase
      .from('ai_agent_revisions')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('agent_id', id)
      .eq('id', revisionId)
      .eq('status', 'draft')
    if (error) {
      console.error('[DELETE ai agents revision] failed:', error)
      return NextResponse.json({ error: 'Failed to discard draft' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
