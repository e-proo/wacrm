// ============================================================
// /api/ai-agents/[id]/revisions/[revisionId]/tools
//
// GET   — the full tool registry + the revision's current grants
//         (the matrix the builder UI renders).
// PUT   — replace EVERY grant of a DRAFT revision atomically via
//         the replace_ai_agent_tool_grants SQL function (draft
//         re-check + delete + insert in one transaction, row
//         locked against a concurrent publish). Validated against
//         the registry:
//           • tool must exist,
//           • version must equal the registry version (no stale),
//           • permission must be one the tool allows,
//           • constraints must be a JSON object.
//
// Published revisions are immutable — grants change on the draft.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { getCurrentToolDefinition, listCurrentToolDefinitions } from '@/lib/ai/tools/platform/runtime-tool-compat'

interface GrantInput {
  tool_key: string
  permission: 'read' | 'propose' | 'execute'
  constraints?: Record<string, unknown>
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; revisionId: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:aiRevisionTools:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id, revisionId } = await params

    const { data: revision, error: revErr } = await ctx.supabase
      .from('ai_agent_revisions')
      .select('id, status')
      .eq('account_id', ctx.accountId)
      .eq('agent_id', id)
      .eq('id', revisionId)
      .maybeSingle()
    if (revErr) throw revErr
    if (!revision) {
      return NextResponse.json({ error: 'Revision not found' }, { status: 404 })
    }

    const { data: grants, error } = await ctx.supabase
      .from('ai_agent_tool_grants')
      .select('tool_key, tool_version, permission, constraints')
      .eq('account_id', ctx.accountId)
      .eq('agent_revision_id', revisionId)
    if (error) throw error
    return NextResponse.json({
      registry: listCurrentToolDefinitions(),
      grants: grants ?? [],
      revisionStatus: (revision as { status: string }).status,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; revisionId: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:aiRevisionToolsPut:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id, revisionId } = await params

    const { data: revision, error: revErr } = await ctx.supabase
      .from('ai_agent_revisions')
      .select('id, agent_id, status')
      .eq('account_id', ctx.accountId)
      .eq('agent_id', id)
      .eq('id', revisionId)
      .maybeSingle()
    if (revErr) throw revErr
    if (!revision) {
      return NextResponse.json({ error: 'Revision not found' }, { status: 404 })
    }
    if ((revision as { status: string }).status !== 'draft') {
      return NextResponse.json(
        { error: 'Only draft revisions can change tool grants.', code: 'REVISION_NOT_DRAFT' },
        { status: 409 },
      )
    }

    let body: { grants?: GrantInput[] }
    try {
      body = (await request.json()) as { grants?: GrantInput[] }
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    const grants = body.grants ?? []
    if (!Array.isArray(grants)) {
      return NextResponse.json({ error: 'grants must be an array' }, { status: 400 })
    }

    const seen = new Set<string>()
    const rows: Array<Record<string, unknown>> = []
    for (const g of grants) {
      const tool = getCurrentToolDefinition(g.tool_key)
      if (!tool) {
        return NextResponse.json(
          { error: `Tool not registered: ${g.tool_key}`, code: 'UNKNOWN_TOOL' },
          { status: 400 },
        )
      }
      if (!['read', 'propose', 'execute'].includes(g.permission)) {
        return NextResponse.json(
          { error: `Bad permission for ${g.tool_key}: ${g.permission}` },
          { status: 400 },
        )
      }
      if (!tool.grantPermissions.includes(g.permission as never)) {
        return NextResponse.json(
          {
            error: `Permission ${g.permission} not allowed for ${g.tool_key} (allowed: ${tool.grantPermissions.join(', ')})`,
            code: 'PERMISSION_NOT_ALLOWED',
          },
          { status: 400 },
        )
      }
      if (g.constraints !== undefined && (typeof g.constraints !== 'object' || g.constraints === null)) {
        return NextResponse.json(
          { error: `constraints for ${g.tool_key} must be an object` },
          { status: 400 },
        )
      }
      if (seen.has(tool.key)) {
        return NextResponse.json(
          { error: `Duplicate tool grant: ${tool.key}` },
          { status: 400 },
        )
      }
      seen.add(tool.key)
      rows.push({
        tool_key: tool.key,
        tool_version: tool.version,
        permission: g.permission,
        constraints: g.constraints ?? {},
      })
    }

    // Single transaction: the function re-locks the revision and
    // refuses the write if a concurrent publish flipped the state
    // between the check above and the replace below.
    const { data: replaced, error } = await ctx.supabase.rpc(
      'replace_ai_agent_tool_grants',
      {
        p_account_id: ctx.accountId,
        p_agent_id: id,
        p_revision_id: revisionId,
        p_grants: rows,
        p_granted_by: ctx.userId,
      },
    )
    if (error) {
      const msg = (error as { message?: string }).message ?? ''
      if (msg.includes('only draft revisions')) {
        return NextResponse.json(
          { error: 'Only draft revisions can change tool grants.', code: 'REVISION_NOT_DRAFT' },
          { status: 409 },
        )
      }
      if (msg.includes('revision not found')) {
        return NextResponse.json({ error: 'Revision not found' }, { status: 404 })
      }
      console.error('[PUT revision tools] replace failed:', error)
      return NextResponse.json({ error: 'Failed to write grants' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, count: replaced ?? 0 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
