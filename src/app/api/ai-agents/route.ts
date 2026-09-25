// ============================================================
// GET  /api/ai-agents            — list agents for the account
// POST /api/ai-agents            — two paths:
//   1. { agentId, ... }   — create + publish a new revision for
//                            an EXISTING agent (Phase 1 path).
//   2. { templateId, name, ... } — create a NEW agent seeded
//                            from a builder template (Phase 4).
//                            The first revision stays a DRAFT;
//                            publishing goes through the
//                            existing revision publish flow.
//
// Both paths require admin+.
// ============================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { publishAgentRevision } from '@/lib/ai/runtime/agents-service'
import { getCurrentPlatformTool } from '@/lib/ai/tools/platform/current-domain-registry'
import {
  SLUG_PATTERN_BUILDER,
  deriveSlugFromName,
} from '@/lib/ai/runtime/slug'

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

    const { data: revisions, error: revisionsError } = await ctx.supabase
      .from('ai_agent_revisions')
      .select('id, agent_id, revision_number, status')
      .eq('account_id', ctx.accountId)
      .order('revision_number', { ascending: false })
    if (revisionsError) {
      console.error('[GET /api/ai-agents] revisions error:', revisionsError)
      return NextResponse.json({ error: 'Failed to list agent revisions' }, { status: 500 })
    }
    const latestDraftByAgent = new Map<string, string>()
    for (const revision of revisions ?? []) {
      const row = revision as { id: string; agent_id: string; status: string }
      if (row.status === 'draft' && !latestDraftByAgent.has(row.agent_id)) {
        latestDraftByAgent.set(row.agent_id, row.id)
      }
    }
    const agents = (data ?? []).map((agent) => ({
      ...agent,
      latest_draft_revision_id: latestDraftByAgent.get((agent as { id: string }).id) ?? null,
    }))
    return NextResponse.json({ agents })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CreateRevisionBody {
  // Phase 4 builder path: when `templateId` is provided, the
  // endpoint creates a NEW agent seeded from the template
  // instead of adding a revision to an existing agent.
  templateId?: string
  name?: string
  slug?: string
  description?: string | null
  // Existing path: add a revision to an existing agent.
  agentId?: string
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

// ------------------------------------------------------------
// Phase 4 builder: create a NEW agent from a template.
// Scoped to admins; respects the template's purpose ceiling.
// ------------------------------------------------------------
async function createAgentFromTemplate(
  db: SupabaseClient,
  ctx: { accountId: string; userId: string },
  body: CreateRevisionBody,
): Promise<NextResponse> {
  if (!body.templateId || !body.name) {
    return NextResponse.json(
      { error: 'templateId and name are required' },
      { status: 400 },
    )
  }
  const slug = body.slug?.trim() || deriveSlugFromName(body.name)
  if (!SLUG_PATTERN_BUILDER.test(slug)) {
    return NextResponse.json(
      { error: 'slug must be lowercase alphanumeric with optional hyphens' },
      { status: 400 },
    )
  }

  // Load the template: system (account_id null) or owned.
  const { data: tpl, error: tplErr } = await db
    .from('ai_agent_templates')
    .select(
      'id, account_id, name, description, purpose, version, default_settings, suggested_tool_keys',
    )
    .eq('id', body.templateId)
    .or(`account_id.is.null,account_id.eq.${ctx.accountId}`)
    .eq('is_active', true)
    .maybeSingle()
  if (tplErr) {
    console.error('[POST /api/ai-agents] template read failed:', tplErr)
    return NextResponse.json(
      { error: 'Failed to read template' },
      { status: 500 },
    )
  }
  if (!tpl) {
    return NextResponse.json(
      { error: 'Template not found' },
      { status: 404 },
    )
  }

  // Require an active provider connection for the first revision.
  let providerConnectionId = body.providerConnectionId ?? null
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
  if (!providerConnectionId) {
    return NextResponse.json(
      {
        error:
          'No active provider connection. Add one from the Providers tab first.',
        code: 'NO_ACTIVE_CONNECTION',
      },
      { status: 409 },
    )
  }

  const settings = (tpl as { default_settings: Record<string, unknown> }).default_settings ?? {}
  const model = body.model ?? 'gpt-4o-mini'

  // Create the agent identity. System agents are reserved — a
  // template clone is always purpose-mapped but never takes a
  // system_key.
  const purpose = (tpl as { purpose: string }).purpose
  const { data: agentRow, error: agentErr } = await db
    .from('ai_agents')
    .insert({
      account_id: ctx.accountId,
      system_key: null,
      slug,
      name: body.name.trim(),
      description: body.description ?? (tpl as { description: string | null }).description,
      purpose,
      status: 'draft',
      created_by: ctx.userId,
    })
    .select(
      'id, account_id, system_key, slug, name, description, purpose, status, published_revision_id, version, created_at, updated_at',
    )
    .single()
  if (agentErr || !agentRow) {
    const code = (agentErr as { code?: string } | null)?.code
    if (code === '23505') {
      return NextResponse.json(
        { error: 'An agent with that slug already exists.' },
        { status: 409 },
      )
    }
    console.error('[POST /api/ai-agents] agent insert failed:', agentErr)
    return NextResponse.json(
      { error: 'Failed to create agent' },
      { status: 500 },
    )
  }
  const agentId = (agentRow as { id: string }).id

  // First revision seeded from template defaults + body overrides.
  const { data: revRow, error: revErr } = await db
    .from('ai_agent_revisions')
    .insert({
      account_id: ctx.accountId,
      agent_id: agentId,
      revision_number: 1,
      status: 'draft',
      provider_connection_id: providerConnectionId,
      model,
      system_prompt: body.systemPrompt ?? null,
      response_style:
        body.responseStyle ??
        ((settings.response_style as 'concise' | 'balanced' | 'detailed') || 'balanced'),
      language_policy: body.languagePolicy ?? ((settings.language_policy as string) || 'auto'),
      temperature: body.temperature ?? null,
      max_output_tokens: body.maxOutputTokens ?? null,
      max_tool_rounds:
        typeof settings.max_tool_rounds === 'number'
          ? settings.max_tool_rounds
          : 0,
      max_ai_replies_per_conversation:
        body.maxAiRepliesPerConversation ??
        (typeof settings.max_ai_replies_per_conversation === 'number'
          ? settings.max_ai_replies_per_conversation
          : 3),
      handoff_human_member_id: body.handoffHumanMemberId ?? null,
      settings: { source_template_id: (tpl as { id: string }).id },
      created_by: ctx.userId,
    })
    .select('id')
    .single()
  if (revErr || !revRow) {
    console.error('[POST /api/ai-agents] revision insert failed:', revErr)
    // Clean up the orphan agent shell so a retry isn't blocked
    // by the unique slug.
    await db.from('ai_agents').delete().eq('id', agentId)
    return NextResponse.json(
      { error: 'Failed to create revision' },
      { status: 500 },
    )
  }
  const revisionId = (revRow as { id: string }).id

  // Copy the template's suggested tool keys into grants using the
  // current platform registry. Native business-domain tools are intentionally
  // absent from the contracted legacy ToolDefinition registry, so template
  // seeding must resolve them from PlatformToolManifest ownership.
  const suggested = Array.isArray(
    (tpl as { suggested_tool_keys: unknown }).suggested_tool_keys,
  )
    ? ((tpl as { suggested_tool_keys: unknown[] }).suggested_tool_keys as string[])
    : []
  const grants = suggested
    .map((key) => getCurrentPlatformTool(key))
    .filter(
      (tool): tool is NonNullable<typeof tool> =>
        Boolean(tool) && tool.modelExposed && !tool.serverOnly,
    )
  if (grants.length > 0) {
    await db.from('ai_agent_tool_grants').insert(
      grants.map((tool) => ({
        account_id: ctx.accountId,
        agent_revision_id: revisionId,
        tool_key: tool.key,
        tool_version: tool.version,
        permission: tool.permission as 'read' | 'propose' | 'execute',
        constraints: {},
        granted_by: ctx.userId,
      })),
    )
  }

  // The revision stays a DRAFT: the builder's publish step (step
  // 8) is what goes live. Return the draft for the wizard to
  // continue editing.
  return NextResponse.json({
    agent: agentRow,
    revisionId,
    suggestedTools: grants.map((g) => g.key),
    droppedTools: suggested.filter((k) => !grants.some((g) => g.key === k)),
  })
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

    // Phase 4 builder path.
    if (body.templateId) {
      return await createAgentFromTemplate(
        ctx.supabase,
        { accountId: ctx.accountId, userId: ctx.userId },
        body,
      )
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
    let maxToolRounds = 0
    let maxAiRepliesPerConversation = 3
    let handoffHumanMemberId: string | null = null
    let settings: Record<string, unknown> = {}

    if (
      (agentRow as { published_revision_id: string | null }).published_revision_id
    ) {
      const { data: prev, error: prevErr } = await ctx.supabase
        .from('ai_agent_revisions')
        .select(
          'revision_number, provider_connection_id, model, system_prompt, response_style, language_policy, temperature, max_output_tokens, max_tool_rounds, max_ai_replies_per_conversation, handoff_human_member_id, settings',
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
          max_tool_rounds: number
          max_ai_replies_per_conversation: number
          handoff_human_member_id: string | null
          settings: Record<string, unknown>
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
        maxToolRounds = p.max_tool_rounds
        maxAiRepliesPerConversation =
          body.maxAiRepliesPerConversation ??
          p.max_ai_replies_per_conversation
        handoffHumanMemberId =
          body.handoffHumanMemberId ?? p.handoff_human_member_id
        settings = p.settings ?? {}
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
        max_tool_rounds: maxToolRounds,
        max_ai_replies_per_conversation: maxAiRepliesPerConversation,
        handoff_human_member_id: handoffHumanMemberId,
        settings,
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
