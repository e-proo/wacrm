import { describe, expect, it } from 'vitest'
import { supabaseAdmin } from '../admin-client'
import { runAgentLoop } from '../runtime/agent-loop'
import type { AiAgentRevision } from '../runtime/multi-agent-types'
import type { ChatMessage } from '../types'

const enabled =
  process.env.WACRM_AGENT_TASK_DRY_RUN_LIVE === '1'
const liveDescribe = enabled ? describe : describe.skip

const accountId = process.env.WACRM_AGENT_TASK_CUTOVER_ACCOUNT_ID
const pilotSlug =
  process.env.WACRM_AGENT_TASK_PILOT_AGENT_SLUG ??
  'phase18-coverage-pilot'

liveDescribe('Agent Task Phase 18 provider-backed dry run', () => {
  it('executes the published pilot revision in simulation without business mutation or transport', async () => {
    if (!accountId) {
      throw new Error('WACRM_AGENT_TASK_CUTOVER_ACCOUNT_ID_REQUIRED')
    }
    if (
      !process.env.NEXT_PUBLIC_SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !process.env.ENCRYPTION_KEY
    ) {
      throw new Error('SUPABASE_TEST_ENV_REQUIRED')
    }

    const db = supabaseAdmin()
    const { data: agent, error: agentError } = await db
      .from('ai_agents')
      .select('id, purpose, published_revision_id')
      .eq('account_id', accountId)
      .eq('slug', pilotSlug)
      .eq('status', 'active')
      .maybeSingle()
    if (agentError) throw agentError
    if (!agent?.published_revision_id) {
      throw new Error('PHASE18_PILOT_AGENT_NOT_PUBLISHED')
    }

    const { data: revisionRow, error: revisionError } = await db
      .from('ai_agent_revisions')
      .select(
        'id, account_id, agent_id, revision_number, status, provider_connection_id, model, system_prompt, response_style, language_policy, temperature, max_output_tokens, max_tool_rounds, max_ai_replies_per_conversation, handoff_human_member_id, settings, created_at, published_at, published_by, rejection_reason',
      )
      .eq('account_id', accountId)
      .eq('agent_id', agent.id)
      .eq('id', agent.published_revision_id)
      .maybeSingle()
    if (revisionError) throw revisionError
    if (!revisionRow) {
      throw new Error('PHASE18_PILOT_REVISION_NOT_FOUND')
    }

    const { data: testCase, error: caseError } = await db
      .from('ai_agent_test_cases')
      .select('input_messages')
      .eq('account_id', accountId)
      .eq('agent_id', agent.id)
      .eq('name', '[Phase 18] Coverage pilot safe dry run')
      .maybeSingle()
    if (caseError) throw caseError
    if (!testCase) throw new Error('PHASE18_DRY_RUN_CASE_REQUIRED')

    const messages = normalizeMessages(testCase.input_messages)
    expect(messages.length).toBeGreaterThan(0)

    const before = await businessMutationSnapshot(accountId)

    const loop = await runAgentLoop({
      accountId,
      runId: null,
      agentId: agent.id,
      agentPurpose: agent.purpose as 'custom',
      revision: mapRevision(revisionRow as Record<string, unknown>),
      messages,
      contactId: null,
      conversationId: null,
      sourceMessageId: null,
      plane: 'customer',
      channel: 'whatsapp',
      trustedAdminIdentityId: null,
      trustedAdminCapabilities: [],
      simulation: true,
    })

    const after = await businessMutationSnapshot(accountId)

    expect(loop.status).not.toBe('failed')
    expect(after).toEqual(before)
    expect(
      loop.toolCalls.some(
        (call) =>
          call.toolKey === 'coverage.propose_offer' && call.ok === true,
      ),
    ).toBe(false)

    console.info(
      JSON.stringify(
        {
          status: loop.status,
          toolCalls: loop.toolCalls,
          inputTokens: loop.inputTokens,
          outputTokens: loop.outputTokens,
          responseLength: loop.text?.length ?? 0,
        },
        null,
        2,
      ),
    )
  }, 120_000)
})

async function businessMutationSnapshot(accountId: string) {
  const db = supabaseAdmin()
  const [changes, offers, events, messages] = await Promise.all([
    db
      .from('change_requests')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId),
    db
      .from('coverage_offers')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId),
    db
      .from('business_event_outbox')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId),
    db
      .from('messages')
      .select('id, conversations!inner(account_id)', {
        count: 'exact',
        head: true,
      })
      .eq('conversations.account_id', accountId),
  ])
  for (const result of [changes, offers, events, messages]) {
    if (result.error) throw result.error
  }
  return {
    changeRequests: changes.count ?? 0,
    coverageOffers: offers.count ?? 0,
    businessEvents: events.count ?? 0,
    messages: messages.count ?? 0,
  }
}

function normalizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, 3)
    .map((entry) => {
      if (typeof entry === 'string') {
        return { role: 'user' as const, content: entry.trim() }
      }
      if (entry && typeof entry === 'object') {
        const row = entry as { role?: unknown; content?: unknown }
        return {
          role:
            row.role === 'assistant'
              ? ('assistant' as const)
              : ('user' as const),
          content:
            typeof row.content === 'string'
              ? row.content.trim()
              : '',
        }
      }
      return { role: 'user' as const, content: '' }
    })
    .filter((message) => message.content.length > 0)
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
    systemPrompt:
      typeof row.system_prompt === 'string' ? row.system_prompt : null,
    responseStyle:
      String(row.response_style) as AiAgentRevision['responseStyle'],
    languagePolicy: String(row.language_policy ?? 'auto'),
    temperature:
      row.temperature == null ? null : Number(row.temperature),
    maxOutputTokens:
      row.max_output_tokens == null
        ? null
        : Number(row.max_output_tokens),
    maxToolRounds: Number(row.max_tool_rounds ?? 0),
    maxAiRepliesPerConversation: Number(
      row.max_ai_replies_per_conversation ?? 3,
    ),
    handoffHumanMemberId:
      typeof row.handoff_human_member_id === 'string'
        ? row.handoff_human_member_id
        : null,
    settings:
      row.settings && typeof row.settings === 'object'
        ? (row.settings as Record<string, unknown>)
        : {},
    createdAt: String(row.created_at ?? ''),
    publishedAt:
      typeof row.published_at === 'string'
        ? row.published_at
        : null,
    publishedBy:
      typeof row.published_by === 'string'
        ? row.published_by
        : null,
    rejectionReason:
      typeof row.rejection_reason === 'string'
        ? row.rejection_reason
        : null,
  }
}
