import { supabaseAdmin } from '../admin-client'

export type AgentTaskTestCutoverMode = 'disabled' | 'pilot' | 'inconsistent'

export interface AgentTaskTestCutoverReadiness {
  accountId: string
  mode: AgentTaskTestCutoverMode
  ready: boolean
  blockers: readonly string[]
  runtime: {
    multiAgentEnabled: boolean
    nativeToolsEnabled: boolean
    proposalToolsEnabled: boolean
    recoveryWorkerEnabled: boolean
    outboundTaskDeliveryEnabled: boolean
    killSwitch: boolean
    dailyMessageBudget: number | null
  }
  whatsappScope: {
    exists: boolean
    enabled: boolean
    dailyRunLimit: number | null
    dailyTargetLimit: number | null
    dailyMessageLimit: number | null
  }
  counts: {
    enabledTriggers: number
    nonterminalTriggerFirings: number
    nonterminalTasks: number
    sendingMessages: number
    reconciliationMessages: number
    openWhatsappCircuits: number
  }
}

export interface AgentTaskTestCutoverModeChange {
  mode: Exclude<AgentTaskTestCutoverMode, 'inconsistent'>
  changed: boolean
  before: AgentTaskTestCutoverReadiness
  after: AgentTaskTestCutoverReadiness
}

export async function inspectAgentTaskTestCutoverReadiness(input: {
  accountId: string
}): Promise<AgentTaskTestCutoverReadiness> {
  const { data, error } = await supabaseAdmin().rpc(
    'inspect_ai_agent_task_test_cutover_readiness',
    { p_account_id: input.accountId },
  )
  if (error) throw error
  return parseReadiness(data)
}

export async function setAgentTaskTestCutoverMode(input: {
  accountId: string
  mode: 'disabled' | 'pilot'
  actorId?: string
}): Promise<AgentTaskTestCutoverModeChange> {
  const { data, error } = await supabaseAdmin().rpc(
    'set_ai_agent_task_test_cutover_mode',
    {
      p_account_id: input.accountId,
      p_mode: input.mode,
      p_actor_id: input.actorId ?? 'agent-task-cutover',
    },
  )
  if (error) throw error

  const row = asRecord(data)
  return {
    mode: modeValue(row.mode, false),
    changed: row.changed === true,
    before: parseReadiness(row.before),
    after: parseReadiness(row.after),
  }
}

function parseReadiness(value: unknown): AgentTaskTestCutoverReadiness {
  const row = asRecord(value)
  const runtime = asRecord(row.runtime)
  const whatsapp = asRecord(row.whatsapp_scope)
  const counts = asRecord(row.counts)

  return {
    accountId: stringValue(row.account_id),
    mode: modeValue(row.mode, true),
    ready: row.ready === true,
    blockers: stringArray(row.blockers),
    runtime: {
      multiAgentEnabled: runtime.multi_agent_enabled === true,
      nativeToolsEnabled: runtime.native_tools_enabled === true,
      proposalToolsEnabled: runtime.proposal_tools_enabled === true,
      recoveryWorkerEnabled: runtime.recovery_worker_enabled === true,
      outboundTaskDeliveryEnabled:
        runtime.outbound_task_delivery_enabled === true,
      killSwitch: runtime.kill_switch === true,
      dailyMessageBudget: nullableInteger(runtime.daily_message_budget),
    },
    whatsappScope: {
      exists: whatsapp.exists === true,
      enabled: whatsapp.enabled === true,
      dailyRunLimit: nullableInteger(whatsapp.daily_run_limit),
      dailyTargetLimit: nullableInteger(whatsapp.daily_target_limit),
      dailyMessageLimit: nullableInteger(whatsapp.daily_message_limit),
    },
    counts: {
      enabledTriggers: integerValue(counts.enabled_triggers),
      nonterminalTriggerFirings: integerValue(
        counts.nonterminal_trigger_firings,
      ),
      nonterminalTasks: integerValue(counts.nonterminal_tasks),
      sendingMessages: integerValue(counts.sending_messages),
      reconciliationMessages: integerValue(
        counts.reconciliation_messages,
      ),
      openWhatsappCircuits: integerValue(
        counts.open_whatsapp_circuits,
      ),
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AI_AGENT_TASK_CUTOVER_RESPONSE_INVALID')
  }
  return value as Record<string, unknown>
}

function modeValue(
  value: unknown,
  allowInconsistent: boolean,
): AgentTaskTestCutoverMode {
  if (value === 'disabled' || value === 'pilot') return value
  if (allowInconsistent && value === 'inconsistent') return value
  throw new Error('AI_AGENT_TASK_CUTOVER_MODE_INVALID')
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('AI_AGENT_TASK_CUTOVER_STRING_INVALID')
  }
  return value
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error('AI_AGENT_TASK_CUTOVER_BLOCKERS_INVALID')
  }
  return value
}

function integerValue(value: unknown): number {
  const n = Number(value ?? 0)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('AI_AGENT_TASK_CUTOVER_COUNT_INVALID')
  }
  return n
}

function nullableInteger(value: unknown): number | null {
  if (value == null) return null
  return integerValue(value)
}
