// ============================================================
// POST /api/ai-agents/[id]/revisions — fork the PUBLISHED
//      revision into a new editable DRAFT (idempotent: returns
//      the existing draft when there is one). Copies settings,
//      tool grants and knowledge assignments so the draft starts
//      as a faithful working copy.
//
// Admin+ only. Published/superseded revisions stay immutable —
// all editing happens on the draft, then publish swaps the
// pointer (existing publish route).
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:aiRevisionsFork:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    const db = ctx.supabase

    const { data: agent, error: agentErr } = await db
      .from('ai_agents')
      .select('id, status, published_revision_id')
      .eq('account_id', ctx.accountId)
      .eq('id', id)
      .maybeSingle()
    if (agentErr) throw agentErr
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }
    if ((agent as { status: string }).status === 'archived') {
      return NextResponse.json(
        { error: 'Archived agents cannot get new revisions.', code: 'AGENT_ARCHIVED' },
        { status: 409 },
      )
    }

    // Idempotent: an existing draft wins — never fork twice.
    const { data: existingDraft, error: draftErr } = await db
      .from('ai_agent_revisions')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('agent_id', id)
      .eq('status', 'draft')
      .order('revision_number', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (draftErr) throw draftErr
    if (existingDraft) {
      return NextResponse.json({
        revisionId: (existingDraft as { id: string }).id,
        reused: true,
      })
    }

    const publishedId = (agent as { published_revision_id: string | null })
      .published_revision_id
    let source: Record<string, unknown> | null = null
    if (publishedId) {
      const { data: prev, error: prevErr } = await db
        .from('ai_agent_revisions')
        .select(
          'revision_number, provider_connection_id, model, system_prompt, response_style, language_policy, temperature, max_output_tokens, max_tool_rounds, max_ai_replies_per_conversation, handoff_human_member_id, settings',
        )
        .eq('account_id', ctx.accountId)
        .eq('id', publishedId)
        .maybeSingle()
      if (prevErr) throw prevErr
      source = prev as unknown as Record<string, unknown> | null
    }

    const { data: maxRow, error: maxErr } = await db
      .from('ai_agent_revisions')
      .select('revision_number')
      .eq('account_id', ctx.accountId)
      .eq('agent_id', id)
      .order('revision_number', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (maxErr) throw maxErr
    const nextNumber =
      ((maxRow as { revision_number?: number } | null)?.revision_number ?? 0) + 1

    // The draft needs an active provider connection + model to
    // publish later — inherit from source or the newest active
    // connection; a blank draft is still allowed (validation
    // happens at publish).
    let providerConnectionId =
      (source?.provider_connection_id as string | null) ?? null
    if (!providerConnectionId) {
      const { data: conn } = await db
        .from('ai_provider_connections')
        .select('id')
        .eq('account_id', ctx.accountId)
        .in('status', ['active', 'verified'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      providerConnectionId = conn ? (conn as { id: string }).id : null
    }

    const { data: created, error: insErr } = await db
      .from('ai_agent_revisions')
      .insert({
        account_id: ctx.accountId,
        agent_id: id,
        revision_number: nextNumber,
        status: 'draft',
        provider_connection_id: providerConnectionId,
        model: (source?.model as string) ?? '',
        system_prompt: (source?.system_prompt as string) ?? null,
        response_style: (source?.response_style as string) ?? 'balanced',
        language_policy: (source?.language_policy as string) ?? 'auto',
        temperature: (source?.temperature as number | null) ?? null,
        max_output_tokens: (source?.max_output_tokens as number | null) ?? null,
        max_tool_rounds: (source?.max_tool_rounds as number) ?? 0,
        max_ai_replies_per_conversation:
          (source?.max_ai_replies_per_conversation as number) ?? 3,
        handoff_human_member_id:
          (source?.handoff_human_member_id as string | null) ?? null,
        settings: (source?.settings as Record<string, unknown>) ?? {},
        created_by: ctx.userId,
      })
      .select('id')
      .single()
    if (insErr || !created) {
      console.error('[POST /api/ai-agents/[id]/revisions] insert failed:', insErr)
      return NextResponse.json(
        { error: 'Failed to create draft revision' },
        { status: 500 },
      )
    }
    const revisionId = (created as { id: string }).id

    // Copy grants + knowledge assignments from the published
    // revision so the working draft mirrors what agents answer
    // with today. Failures here are non-fatal (logged): the
    // draft is already usable and can be re-granted in the UI.
    let copiedGrants = 0
    if (publishedId) {
      const { data: grantRows, error: gReadErr } = await db
        .from('ai_agent_tool_grants')
        .select('tool_key, tool_version, permission, constraints')
        .eq('account_id', ctx.accountId)
        .eq('agent_revision_id', publishedId)
      if (gReadErr) console.error('[revisions fork] grant read failed:', gReadErr)
      if (grantRows && grantRows.length > 0) {
        const { error: gInsErr } = await db.from('ai_agent_tool_grants').insert(
          (grantRows as Array<Record<string, unknown>>).map((g) => ({
            ...g,
            account_id: ctx.accountId,
            agent_revision_id: revisionId,
            granted_by: ctx.userId,
          })),
        )
        if (gInsErr) console.error('[revisions fork] grant copy failed:', gInsErr)
        else copiedGrants = grantRows.length
      }

      const { data: assignRows, error: aReadErr } = await db
        .from('ai_agent_knowledge_assignments')
        .select('knowledge_chunk_id, priority, enabled')
        .eq('account_id', ctx.accountId)
        .eq('agent_revision_id', publishedId)
      if (aReadErr) console.error('[revisions fork] assignment read failed:', aReadErr)
      if (assignRows && assignRows.length > 0) {
        const { error: aInsErr } = await db
          .from('ai_agent_knowledge_assignments')
          .insert(
            (assignRows as Array<Record<string, unknown>>).map((a) => ({
              ...a,
              account_id: ctx.accountId,
              agent_revision_id: revisionId,
            })),
          )
        if (aInsErr) console.error('[revisions fork] assignment copy failed:', aInsErr)
      }
    }

    return NextResponse.json({ revisionId, copiedGrants })
  } catch (err) {
    return toErrorResponse(err)
  }
}
