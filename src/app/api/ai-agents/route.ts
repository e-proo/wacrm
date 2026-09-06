// ============================================================
// GET  /api/ai-agents            — list agents for the account
// POST /api/ai-agents            — create a draft revision for an
//                                   existing system agent. Phase 1
//                                   intentionally does NOT expose
//                                   creation of NEW agents; only
//                                   revisions of the seeded
//                                   `customer_service` agent.
//
// Both endpoints require admin+.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { publishAgentRevision } from '@/lib/ai/runtime/agents-service'

export async function GET() {
  try {
    const ctx = await requireRole('admin')

    const limit = checkRateLimit(
      `admin:aiAgentsList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { data, error } = await ctx.supabase
      .from('ai_agents')
      .select(
        'id, account_id, system_key, slug, name, description, purpose, status, published_revision_id, version, created_at, updated_at',
      )
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[GET /api/ai-agents] error:', error)
      return NextResponse.json(
        { error: 'Failed to list agents' },
        { status: 500 },
      )
    }

    return NextResponse.json({ agents: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CreateRevisionBody {
  agentId: string
  model?: string
  systemPrompt?: string | null
  responseStyle?: 'concise' | 'balanced' | 'detailed'
  languagePolicy?: string
  temperature?: number | null
  maxOutputTokens?: number | null
  maxAiRepliesPerConversation?: number
  handoffHumanMemberId?: string | null
  providerConnectionId?: string
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const limit = checkRateLimit(
      `admin:aiAgentRevise:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: CreateRevisionBody
    try {
      body = (await request.json()) as CreateRevisionBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (!body.agentId) {
      return NextResponse.json(
        { error: 'agentId is required' },
        { status: 400 },
      )
    }

    // Look up the existing published revision (if any) to use as
    // the template. Phase 1 only edits existing agents — no
    // "create new agent" surface yet.
    const { data: agentRow, error: agentErr } = await ctx.supabase
      .from('ai_agents')
      .select('id, published_revision_id')
      .eq('account_id', ctx.accountId)
      .eq('id', body.agentId)
      .maybeSingle()
    if (agentErr) {
      console.error('[POST /api/ai-agents] agent read failed:', agentErr)
      return NextResponse.json(
        { error: 'Failed to read agent' },
        { status: 500 },
      )
    }
    if (!agentRow) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    let nextRevisionNumber = 1
    let providerConnectionId = body.providerConnectionId ?? null
    let model = body.model ?? null
    let systemPrompt = body.systemPrompt ?? null
    let responseStyle: 'concise' | 'balanced' | 'detailed' = 'balanced'
    let languagePolicy = 'auto'
    let temperature: number | null = null
    let maxOutputTokens: number | null = null
    let maxAiRepliesPerConversation = 3
    let handoffHumanMemberId: string | null = null

    if (
      (agentRow as { published_revision_id: string | null }).published_revision_id
    ) {
      const { data: prev, error: prevErr } = await ctx.supabase
        .from('ai_agent_revisions')
        .select(
          'revision_number, provider_connection_id, model, system_prompt, response_style, language_policy, temperature, max_output_tokens, max_ai_replies_per_conversation, handoff_human_member_id',
        )
        .eq('account_id', ctx.accountId)
        .eq(
          'id',
          (agentRow as { published_revision_id: string }).published_revision_id,
        )
        .maybeSingle()
      if (prevErr) {
        console.error('[POST /api/ai-agents] prev read failed:', prevErr)
        return NextResponse.json(
          { error: 'Failed to read previous revision' },
          { status: 500 },
        )
      }
      if (prev) {
        const p = prev as {
          revision_number: number
          provider_connection_id: string
          model: string
          system_prompt: string | null
          response_style: string
          language_policy: string
          temperature: number | null
          max_output_tokens: number | null
          max_ai_replies_per_conversation: number
          handoff_human_member_id: string | null
        }
        nextRevisionNumber = p.revision_number + 1
        providerConnectionId = providerConnectionId ?? p.provider_connection_id
        model = model ?? p.model
        systemPrompt = systemPrompt ?? p.system_prompt
        responseStyle =
          (body.responseStyle as 'concise' | 'balanced' | 'detailed' | undefined) ??
          ((p.response_style as 'concise' | 'balanced' | 'detailed') || 'balanced')
        languagePolicy = body.languagePolicy ?? p.language_policy
        temperature = body.temperature ?? p.temperature
        maxOutputTokens = body.maxOutputTokens ?? p.max_output_tokens
        maxAiRepliesPerConversation =
          body.maxAiRepliesPerConversation ??
          p.max_ai_replies_per_conversation
        handoffHumanMemberId =
          body.handoffHumanMemberId ?? p.handoff_human_member_id
      }
    }

    if (!providerConnectionId || !model) {
      return NextResponse.json(
        {
          error:
            'providerConnectionId and model are required for the first revision',
        },
        { status: 400 },
      )
    }

    // Create the draft revision.
    const { data: revRow, error: insErr } = await ctx.supabase
      .from('ai_agent_revisions')
      .insert({
        account_id: ctx.accountId,
        agent_id: body.agentId,
        revision_number: nextRevisionNumber,
        status: 'draft',
        provider_connection_id: providerConnectionId,
        model,
        system_prompt: systemPrompt,
        response_style: responseStyle,
        language_policy: languagePolicy,
        temperature,
        max_output_tokens: maxOutputTokens,
        max_tool_rounds: 0,
        max_ai_replies_per_conversation: maxAiRepliesPerConversation,
        handoff_human_member_id: handoffHumanMemberId,
        settings: {},
        created_by: ctx.userId,
      })
      .select('id')
      .single()
    if (insErr || !revRow) {
      console.error('[POST /api/ai-agents] insert revision failed:', insErr)
      return NextResponse.json(
        { error: 'Failed to create revision' },
        { status: 500 },
      )
    }
    const revisionId = (revRow as { id: string }).id

    // Auto-publish: Phase 1 has no separate "review then publish"
    // UX — the user-facing screen is a single submit. Future
    // phases can split this with a `?publish=false` query.
    let agent
    try {
      agent = await publishAgentRevision(ctx.supabase, {
        accountId: ctx.accountId,
        agentId: body.agentId,
        revisionId,
        actorUserId: ctx.userId,
      })
    } catch (publishErr) {
      // Surface the typed error code so the UI can react.
      const code =
        (publishErr as { code?: string }).code ?? 'PUBLISH_FAILED'
      const message = (publishErr as Error).message ?? 'Publish failed'
      const status = (publishErr as { status?: number }).status ?? 400
      return NextResponse.json({ error: message, code }, { status })
    }

    return NextResponse.json({ agent, revisionId })
  } catch (err) {
    return toErrorResponse(err)
  }
}
