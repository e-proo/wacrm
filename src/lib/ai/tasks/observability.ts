import { supabaseAdmin } from '../admin-client'

export interface AgentTaskTrace {
  task: Record<string, unknown>
  targets: ReadonlyArray<Record<string, unknown>>
  task_events: ReadonlyArray<Record<string, unknown>>
  runs: ReadonlyArray<Record<string, unknown>>
  tool_calls: ReadonlyArray<Record<string, unknown>>
  outbound_messages: ReadonlyArray<Record<string, unknown>>
  replies: ReadonlyArray<Record<string, unknown>>
  change_requests: ReadonlyArray<Record<string, unknown>>
  business_outcomes: ReadonlyArray<Record<string, unknown>>
  circuit_events: ReadonlyArray<Record<string, unknown>>
}

export interface AgentTaskMetrics {
  window: { from: string; to: string }
  tasks_started: number
  tasks_completed: number
  targets_selected: number
  targets_skipped: number
  contacts_reached: number
  replies: number
  reply_rate: number
  positive_replies: number
  positive_reply_rate: number
  positive_reply_basis: string
  business_outcomes: number
  avg_attempts_per_target: number
  tool_failures: number
  provider_failures: number
  meta_failures: number
  input_tokens: number
  output_tokens: number
  provider_cost_micros: number
  estimated_provider_cost_micros: number
  uncosted_runs: number
  sent_messages: number
  message_cost_micros: number | null
  message_cost_status: string
  uncosted_sent_messages: number
  human_handoffs: number
  opt_outs: number
  opt_out_rate: number
}

/**
 * Redacted execution lineage. The database RPC intentionally excludes message
 * bodies, tool arguments, prompts, secrets and hidden model reasoning.
 */
export async function inspectAgentTaskTrace(input: {
  accountId: string
  taskId: string
}): Promise<AgentTaskTrace | null> {
  const { data, error } = await supabaseAdmin().rpc(
    'inspect_ai_agent_task_trace',
    {
      p_account_id: input.accountId,
      p_task_id: input.taskId,
    },
  )
  if (error) throw error
  if (!data) return null
  return data as AgentTaskTrace
}

export async function inspectAgentTaskMetrics(input: {
  accountId: string
  from: Date
  to: Date
}): Promise<AgentTaskMetrics> {
  if (
    Number.isNaN(input.from.getTime()) ||
    Number.isNaN(input.to.getTime()) ||
    input.from >= input.to
  ) {
    throw new Error('AI_TASK_METRICS_WINDOW_INVALID')
  }

  const { data, error } = await supabaseAdmin().rpc(
    'inspect_ai_agent_task_metrics',
    {
      p_account_id: input.accountId,
      p_from: input.from.toISOString(),
      p_to: input.to.toISOString(),
    },
  )
  if (error) throw error
  if (!data || typeof data !== 'object') {
    throw new Error('AI_TASK_METRICS_RESULT_INVALID')
  }
  return data as AgentTaskMetrics
}
