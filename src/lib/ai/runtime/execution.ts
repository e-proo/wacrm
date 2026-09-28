import { supabaseAdmin } from '../admin-client'
import type { ChatMessage } from '../types'
import { CURRENT_AGENT_TASK_PLATFORM } from '../tasks/current-platform'
import { authorizeStoredAgentTask } from '../tasks/capability-policy'
import { runAgentLoop, type AgentLoopResult } from './agent-loop'
import type {
  AiAgentRevision,
  AgentPurpose,
  Channel,
  RunPlane,
  Uuid,
} from './multi-agent-types'

export type AgentExecutionMode = 'inbound' | 'outbound' | 'simulation'

/**
 * Shared execution context. It describes an already-created run without
 * encoding how that run was triggered. Inbound routing and task orchestration
 * are separate entry points that converge here.
 */
export interface AgentExecutionContext {
  accountId: string
  runId: Uuid
  mode: AgentExecutionMode
  agentId: Uuid
  revisionId: Uuid
  conversationId: Uuid
  contactId: Uuid | null
  taskId?: Uuid | null
  taskTargetId?: Uuid | null
  plane: RunPlane
  counterpartyRole?: string | null
  channel: Channel
  sourceMessageId?: Uuid | null
}

export type AgentExecutionStatus =
  | 'message_ready'
  | 'no_message'
  | 'needs_human'
  | 'target_complete'
  | 'needs_followup'
  | 'failed'

export interface AgentExecutionResult {
  status: AgentExecutionStatus
  customerMessage: string | null
  taskOutcome: Readonly<Record<string, unknown>> | null
  nextActionHint: string | null
  toolCalls: AgentLoopResult['toolCalls']
  usage: {
    inputTokens: number
    outputTokens: number
  }
  latestUserMessage: string
  error: string | null
}

export interface LoadExecutionRevisionInput {
  accountId: string
  agentId: string
  revisionId: string
  providerConnectionId: string
}

export type LoadExecutionRevisionResult =
  | { ok: true; revision: AiAgentRevision }
  | {
      ok: false
      error: 'REVISION_NOT_FOUND' | 'PROVIDER_CONNECTION_MISMATCH'
    }

export async function claimAgentExecution(input: {
  runId: string
  workerId: string
  leaseSeconds?: number
}): Promise<'claimed' | 'lost'> {
  const db = supabaseAdmin()
  const claimed = await db.rpc('claim_agent_run', {
    p_run_id: input.runId,
    p_claimed_by: input.workerId,
    p_lease_secs: input.leaseSeconds ?? 300,
  })
  if (claimed.error) {
    console.error('[agent execution] claim_agent_run failed:', claimed.error)
    return 'lost'
  }
  if (claimed.data !== 'claimed') return 'lost'
  return 'claimed'
}

export async function loadAgentExecutionRevision(
  input: LoadExecutionRevisionInput,
): Promise<LoadExecutionRevisionResult> {
  const db = supabaseAdmin()
  const { data: revision, error } = await db
    .from('ai_agent_revisions')
    .select(
      'id, agent_id, status, provider_connection_id, model, system_prompt, response_style, language_policy, temperature, max_output_tokens, max_tool_rounds, max_ai_replies_per_conversation, handoff_human_member_id',
    )
    .eq('account_id', input.accountId)
    .eq('agent_id', input.agentId)
    .eq('id', input.revisionId)
    .maybeSingle()

  if (error || !revision) {
    console.error('[agent execution] revision load failed:', error)
    return { ok: false, error: 'REVISION_NOT_FOUND' }
  }

  const raw = revision as {
    id: string
    agent_id: string
    status: string
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
  }

  if (raw.provider_connection_id !== input.providerConnectionId) {
    console.error('[agent execution] frozen provider does not match revision')
    return { ok: false, error: 'PROVIDER_CONNECTION_MISMATCH' }
  }

  return {
    ok: true,
    revision: {
      id: raw.id,
      accountId: input.accountId,
      agentId: raw.agent_id,
      revisionNumber: 0,
      status: (raw.status as AiAgentRevision['status']) ?? 'published',
      providerConnectionId: input.providerConnectionId,
      model: raw.model,
      systemPrompt: raw.system_prompt,
      responseStyle:
        (raw.response_style as AiAgentRevision['responseStyle']) ?? 'balanced',
      languagePolicy: raw.language_policy ?? 'auto',
      temperature: raw.temperature ?? null,
      maxOutputTokens: raw.max_output_tokens ?? null,
      maxToolRounds: raw.max_tool_rounds ?? 0,
      maxAiRepliesPerConversation:
        raw.max_ai_replies_per_conversation ?? 3,
      handoffHumanMemberId: raw.handoff_human_member_id ?? null,
      settings: {},
      createdAt: '',
      publishedAt: null,
      publishedBy: null,
      rejectionReason: null,
    },
  }
}

export function mapAgentLoopToExecutionResult(
  loop: AgentLoopResult,
  latestUserMessage: string,
): AgentExecutionResult {
  const status: AgentExecutionStatus =
    loop.status === 'failed'
      ? 'failed'
      : loop.status === 'handoff'
        ? 'needs_human'
        : loop.text
          ? 'message_ready'
          : 'no_message'

  return {
    status,
    customerMessage: loop.text,
    taskOutcome: loop.taskOutcome ?? null,
    nextActionHint: null,
    toolCalls: loop.toolCalls,
    usage: {
      inputTokens: loop.inputTokens,
      outputTokens: loop.outputTokens,
    },
    latestUserMessage,
    error: loop.error ?? null,
  }
}

export async function runClaimedAgentExecution(input: {
  context: AgentExecutionContext
  revision: AiAgentRevision
  trustedAdminIdentityId?: string | null
  trustedAdminCapabilities?: ReadonlyArray<string>
  contextMessages?: ReadonlyArray<ChatMessage>
}): Promise<AgentExecutionResult> {
  const db = supabaseAdmin()
  const { context, revision } = input

  const [messagesRes, agentRes] = await Promise.all([
    db
      .from('messages')
      .select('sender_type, content_text, created_at')
      .eq('conversation_id', context.conversationId)
      .order('created_at', { ascending: true }),
    db
      .from('ai_agents')
      .select('purpose')
      .eq('account_id', context.accountId)
      .eq('id', context.agentId)
      .maybeSingle(),
  ])

  if (messagesRes.error) {
    console.error('[agent execution] messages load failed:', messagesRes.error)
    return failedExecution('MESSAGES_LOAD_FAILED')
  }
  if (agentRes.error || !agentRes.data) {
    console.error('[agent execution] agent purpose load failed:', agentRes.error)
    return failedExecution('AGENT_NOT_FOUND')
  }

  const history: ChatMessage[] = (messagesRes.data ?? [])
    .slice(-20)
    .map((message) => {
      const row = message as {
        sender_type: string
        content_text: string | null
      }
      return {
        role:
          row.sender_type === 'customer'
            ? ('user' as const)
            : ('assistant' as const),
        content: String(row.content_text ?? ''),
      }
    })
    .filter((message) => message.content.trim().length > 0)

  const messages = [
    ...history,
    ...(input.contextMessages ?? []),
  ]
  const latestUserMessage =
    [...messages].reverse().find((message) => message.role === 'user')?.content ??
    ''

  const agentPurpose = String(
    (agentRes.data as { purpose: string }).purpose,
  ) as AgentPurpose

  let taskPolicy:
    | {
        capabilities: readonly string[]
        allowedTools: readonly { key: string; version: number }[]
        taskType: string
        taskTypeVersion: number
        objective: string
        taskContext: Readonly<Record<string, unknown>>
      }
    | null = null

  if (context.taskId) {
    const authorization = await authorizeStoredAgentTask(db, {
      taskId: context.taskId,
      taskTypes: CURRENT_AGENT_TASK_PLATFORM.taskTypes,
    })

    if (!authorization.ok) {
      console.warn(
        `[agent execution] task policy denied task=${context.taskId.slice(0, 8)} code=${authorization.code}`,
      )
      return failedExecution(authorization.code)
    }

    if (
      authorization.task.accountId !== context.accountId ||
      authorization.task.agentId !== context.agentId ||
      authorization.task.agentRevisionId !== context.revisionId
    ) {
      return failedExecution('TASK_EXECUTION_CONTEXT_MISMATCH')
    }

    taskPolicy = {
      capabilities: authorization.capabilities,
      allowedTools: authorization.allowedTools,
      taskType: authorization.task.taskType,
      taskTypeVersion: authorization.task.taskTypeVersion,
      objective: authorization.task.objective,
      taskContext: authorization.task.taskContext,
    }
  }

  const loop = await runAgentLoop({
    accountId: context.accountId,
    runId: context.runId,
    agentId: context.agentId,
    agentPurpose,
    revision,
    messages,
    contactId: context.contactId,
    conversationId: context.conversationId,
    sourceMessageId: context.sourceMessageId ?? null,
    plane: context.plane,
    channel: context.channel,
    trustedAdminIdentityId: input.trustedAdminIdentityId ?? null,
    trustedAdminCapabilities: input.trustedAdminCapabilities ?? [],
    agentCapabilities: taskPolicy?.capabilities ?? [],
    taskAllowedTools: taskPolicy?.allowedTools ?? null,
    taskExecutionContext: taskPolicy
      ? {
          taskType: taskPolicy.taskType,
          taskTypeVersion: taskPolicy.taskTypeVersion,
          objective: taskPolicy.objective,
          counterpartyRole: context.counterpartyRole ?? null,
          data: taskPolicy.taskContext,
        }
      : null,
    simulation: context.mode === 'simulation',
  })

  console.info(
    `[agent execution] mode=${context.mode} loop=${loop.status} tools=${loop.toolCalls.length} text=${loop.text ? loop.text.length + 'ch' : 'null'}`,
  )

  return mapAgentLoopToExecutionResult(loop, latestUserMessage)

  function failedExecution(error: string): AgentExecutionResult {
    return {
      status: 'failed',
      customerMessage: null,
      taskOutcome: null,
      nextActionHint: null,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      latestUserMessage: '',
      error,
    }
  }
}
