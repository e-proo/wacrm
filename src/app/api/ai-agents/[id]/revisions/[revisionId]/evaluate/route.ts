import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { validateTestCaseShape } from '@/lib/ai/runtime/builder-service'
import { runAgentLoop } from '@/lib/ai/runtime/agent-loop'
import type {
  AgentPurpose,
  AiAgentRevision,
  RunPlane,
  TrustedAdminIdentity,
} from '@/lib/ai/runtime/multi-agent-types'
import type { ChatMessage } from '@/lib/ai/types'

interface TestCaseRow {
  id: string
  name: string
  plane: RunPlane
  input_messages: unknown
  assertions: unknown
  is_required: boolean
}

interface AssertionSet {
  tool_must_not_call?: string[]
  must_not_leak?: string[]
  must_include?: string[]
  handoff?: boolean
}

/**
 * Real provider-backed SAFE simulation. Read tools may execute; proposal and
 * write effects are denied by ToolContext.simulation=true. This exercises the
 * selected revision provider/model, prompt, KB, tool schemas and runtime policy
 * rather than merely validating fixture JSON shape.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; revisionId: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:agentEvaluate:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id, revisionId } = await params

    const [agentRes, revisionRes, casesRes] = await Promise.all([
      ctx.supabase
        .from('ai_agents')
        .select('id, purpose')
        .eq('account_id', ctx.accountId)
        .eq('id', id)
        .maybeSingle(),
      ctx.supabase
        .from('ai_agent_revisions')
        .select(
          'id, account_id, agent_id, revision_number, status, provider_connection_id, model, system_prompt, response_style, language_policy, temperature, max_output_tokens, max_tool_rounds, max_ai_replies_per_conversation, handoff_human_member_id, settings, created_at, published_at, published_by, rejection_reason',
        )
        .eq('account_id', ctx.accountId)
        .eq('agent_id', id)
        .eq('id', revisionId)
        .maybeSingle(),
      ctx.supabase
        .from('ai_agent_test_cases')
        .select('id, name, plane, input_messages, assertions, is_required')
        .eq('account_id', ctx.accountId)
        .eq('agent_id', id),
    ])
    if (agentRes.error) throw agentRes.error
    if (revisionRes.error) throw revisionRes.error
    if (casesRes.error) throw casesRes.error
    if (!agentRes.data || !revisionRes.data) {
      return NextResponse.json({ error: 'Agent or revision not found' }, { status: 404 })
    }

    const revision = mapRevision(revisionRes.data as Record<string, unknown>)
    const purpose = String(agentRes.data.purpose) as AgentPurpose
    const cases = (casesRes.data ?? []) as unknown as TestCaseRow[]
    const results: Array<Record<string, unknown>> = []
    let totalInputTokens = 0
    let totalOutputTokens = 0

    for (const testCase of cases) {
      const shapeChecks = validateTestCaseShape(testCase)
      if (shapeChecks.some((check) => check.severity === 'error')) {
        results.push({
          test_case_id: testCase.id,
          name: testCase.name,
          passed: false,
          simulated: true,
          provider_backed: false,
          tool_calls: [],
          response: null,
          violations: shapeChecks,
        })
        continue
      }

      const messages = normalizeTestMessages(testCase.input_messages)
      const identity =
        testCase.plane === 'admin'
          ? await loadSimulationAdminIdentity(ctx.supabase, ctx.accountId)
          : null
      if (testCase.plane === 'admin' && !identity) {
        results.push({
          test_case_id: testCase.id,
          name: testCase.name,
          passed: false,
          simulated: true,
          provider_backed: false,
          tool_calls: [],
          response: null,
          violations: [
            {
              path: 'plane',
              code: 'NO_TRUSTED_ADMIN_FOR_ADMIN_TEST',
              message: 'Admin-plane simulation requires an active trusted admin identity.',
              severity: 'error',
            },
          ],
        })
        continue
      }

      const loop = await runAgentLoop({
        accountId: ctx.accountId,
        runId: null,
        agentId: id,
        agentPurpose: purpose,
        revision,
        messages,
        contactId: null,
        conversationId: null,
        sourceMessageId: null,
        plane: testCase.plane,
        channel: 'whatsapp',
        trustedAdminIdentityId: identity?.id ?? null,
        trustedAdminCapabilities: identity?.allowedCapabilities ?? [],
        simulation: true,
      })
      totalInputTokens += loop.inputTokens
      totalOutputTokens += loop.outputTokens

      const assertionViolations = evaluateAssertions(
        (testCase.assertions ?? {}) as AssertionSet,
        loop,
      )
      if (loop.status === 'failed') {
        assertionViolations.push({
          path: 'runtime',
          code: 'SIMULATION_RUNTIME_FAILED',
          message: loop.error ?? 'Runtime failed without a final response.',
          severity: 'error',
        })
      }
      results.push({
        test_case_id: testCase.id,
        name: testCase.name,
        passed: assertionViolations.length === 0,
        simulated: true,
        provider_backed: true,
        tool_calls: loop.toolCalls,
        response: loop.text,
        handoff: loop.handoffRequested,
        input_tokens: loop.inputTokens,
        output_tokens: loop.outputTokens,
        violations: assertionViolations,
      })
    }

    const failedCases = results.filter((result) => result.passed !== true).length
    const status = failedCases === 0 ? 'passed' : 'failed'
    const { data, error } = await ctx.supabase
      .from('ai_agent_evaluation_runs')
      .insert({
        account_id: ctx.accountId,
        agent_id: id,
        revision_id: revisionId,
        status,
        results,
        total_cases: results.length,
        failed_cases: failedCases,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        created_by: ctx.userId,
        completed_at: new Date().toISOString(),
      })
      .select(
        'id, status, results, total_cases, failed_cases, input_tokens, output_tokens, created_at, completed_at',
      )
      .single()
    if (error) throw error
    return NextResponse.json({ evaluation: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

function normalizeTestMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, 3)
    .map((entry) => {
      if (typeof entry === 'string') return { role: 'user' as const, content: entry.trim() }
      if (entry && typeof entry === 'object') {
        const row = entry as { role?: unknown; content?: unknown }
        const role: ChatMessage['role'] = row.role === 'assistant' ? 'assistant' : 'user'
        return { role, content: typeof row.content === 'string' ? row.content.trim() : '' }
      }
      return { role: 'user' as const, content: '' }
    })
    .filter((message) => message.content.length > 0)
}

async function loadSimulationAdminIdentity(
  db: SupabaseClient,
  accountId: string,
): Promise<TrustedAdminIdentity | null> {
  const { data, error } = await db
    .from('trusted_admin_identities')
    .select(
      'id, account_id, channel, normalized_address, display_name, member_id, status, verification_method, verified_at, revoked_at, allowed_capabilities, created_at',
    )
    .eq('account_id', accountId)
    .eq('channel', 'whatsapp')
    .eq('status', 'active')
    .is('revoked_at', null)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return {
    id: data.id,
    accountId: data.account_id,
    channel: 'whatsapp',
    normalizedAddress: data.normalized_address,
    displayName: data.display_name,
    memberId: data.member_id,
    status: 'active',
    verificationMethod: data.verification_method,
    verifiedAt: data.verified_at,
    revokedAt: data.revoked_at,
    allowedCapabilities: Array.isArray(data.allowed_capabilities) ? data.allowed_capabilities : [],
    createdAt: data.created_at,
  }
}

function evaluateAssertions(
  assertions: AssertionSet,
  loop: Awaited<ReturnType<typeof runAgentLoop>>,
): Array<{ path: string; code: string; message: string; severity: 'error' }> {
  const violations: Array<{ path: string; code: string; message: string; severity: 'error' }> = []
  const response = loop.text ?? ''
  const called = new Set(loop.toolCalls.filter((call) => call.ok).map((call) => call.toolKey))

  for (const tool of assertions.tool_must_not_call ?? []) {
    if (called.has(tool)) {
      violations.push({
        path: 'assertions.tool_must_not_call',
        code: 'FORBIDDEN_TOOL_CALLED',
        message: `Tool ${tool} was called.`,
        severity: 'error',
      })
    }
  }
  for (const secret of assertions.must_not_leak ?? []) {
    if (secret && response.toLocaleLowerCase().includes(secret.toLocaleLowerCase())) {
      violations.push({
        path: 'assertions.must_not_leak',
        code: 'FORBIDDEN_TEXT_LEAKED',
        message: 'Response contained text marked as forbidden by the test case.',
        severity: 'error',
      })
    }
  }
  for (const required of assertions.must_include ?? []) {
    if (required && !response.toLocaleLowerCase().includes(required.toLocaleLowerCase())) {
      violations.push({
        path: 'assertions.must_include',
        code: 'REQUIRED_TEXT_MISSING',
        message: `Response did not contain required text: ${required}`,
        severity: 'error',
      })
    }
  }
  if (typeof assertions.handoff === 'boolean' && loop.handoffRequested !== assertions.handoff) {
    violations.push({
      path: 'assertions.handoff',
      code: 'HANDOFF_ASSERTION_FAILED',
      message: `Expected handoff=${assertions.handoff}.`,
      severity: 'error',
    })
  }
  return violations
}

function mapRevision(row: Record<string, unknown>): AiAgentRevision {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    agentId: String(row.agent_id),
    revisionNumber: Number(row.revision_number),
    status: String(row.status) as AiAgentRevision['status'],
    providerConnectionId: String(row.provider_connection_id),
    model: String(row.model),
    systemPrompt: typeof row.system_prompt === 'string' ? row.system_prompt : null,
    responseStyle: String(row.response_style) as AiAgentRevision['responseStyle'],
    languagePolicy: String(row.language_policy ?? 'auto'),
    temperature: row.temperature == null ? null : Number(row.temperature),
    maxOutputTokens: row.max_output_tokens == null ? null : Number(row.max_output_tokens),
    maxToolRounds: Number(row.max_tool_rounds ?? 0),
    maxAiRepliesPerConversation: Number(row.max_ai_replies_per_conversation ?? 3),
    handoffHumanMemberId:
      typeof row.handoff_human_member_id === 'string' ? row.handoff_human_member_id : null,
    settings:
      row.settings && typeof row.settings === 'object'
        ? (row.settings as Record<string, unknown>)
        : {},
    createdAt: String(row.created_at ?? ''),
    publishedAt: typeof row.published_at === 'string' ? row.published_at : null,
    publishedBy: typeof row.published_by === 'string' ? row.published_by : null,
    rejectionReason: typeof row.rejection_reason === 'string' ? row.rejection_reason : null,
  }
}
