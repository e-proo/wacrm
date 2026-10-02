import { supabaseAdmin } from '../admin-client'

export type RuntimeCircuitScope =
  | 'provider'
  | 'tool'
  | 'channel'
  | 'task_type'

export type RuntimeCircuitOutcome =
  | 'success'
  | 'failure'
  | 'rejection'

export interface RuntimeCircuitState {
  open: boolean
  state: 'closed' | 'open'
  blockedUntil: string | null
  failureCount: number
  rejectionCount: number
  successCount: number
}

export class RuntimeCircuitOpenError extends Error {
  readonly code: string

  constructor(
    readonly scopeType: RuntimeCircuitScope,
    readonly scopeKey: string,
  ) {
    const code =
      'AI_' +
      scopeType.toUpperCase().replace(/[^A-Z0-9]+/g, '_') +
      '_CIRCUIT_OPEN'
    super(code)
    this.name = 'RuntimeCircuitOpenError'
    this.code = code
  }
}

export async function assertRuntimeCircuitClosed(input: {
  accountId: string
  scopeType: RuntimeCircuitScope
  scopeKey: string
}): Promise<void> {
  const state = await readRuntimeCircuitState(input)
  if (state.open) {
    throw new RuntimeCircuitOpenError(input.scopeType, input.scopeKey)
  }
}

export async function readRuntimeCircuitState(input: {
  accountId: string
  scopeType: RuntimeCircuitScope
  scopeKey: string
}): Promise<RuntimeCircuitState> {
  const { data, error } = await supabaseAdmin().rpc(
    'check_ai_agent_circuit_breaker',
    {
      p_account_id: input.accountId,
      p_scope_type: input.scopeType,
      p_scope_key: input.scopeKey,
    },
  )
  if (error) throw error
  return normalizeCircuitState(data)
}

/**
 * Circuit accounting must not turn a successfully completed customer action
 * into a failure. Reads are fail-closed; writes are best-effort with loud logs.
 */
export async function recordRuntimeCircuitEvent(input: {
  accountId: string
  scopeType: RuntimeCircuitScope
  scopeKey: string
  outcome: RuntimeCircuitOutcome
  errorCode?: string | null
  runId?: string | null
  taskId?: string | null
}): Promise<RuntimeCircuitState | null> {
  const { data, error } = await supabaseAdmin().rpc(
    'record_ai_agent_circuit_event_v2',
    {
      p_account_id: input.accountId,
      p_scope_type: input.scopeType,
      p_scope_key: input.scopeKey,
      p_outcome: input.outcome,
      p_error_code: input.errorCode ?? null,
      p_run_id: input.runId ?? null,
      p_task_id: input.taskId ?? null,
    },
  )

  if (error) {
    console.error(
      '[ai circuit] failed to record event:',
      input.scopeType,
      input.scopeKey,
      error,
    )
    return null
  }

  return normalizeCircuitState(data)
}

export function circuitErrorCode(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'UNKNOWN_FAILURE'

  return (
    raw
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || 'UNKNOWN_FAILURE'
  )
}

function normalizeCircuitState(raw: unknown): RuntimeCircuitState {
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}

  return {
    open: value.open === true,
    state: value.state === 'open' ? 'open' : 'closed',
    blockedUntil:
      typeof value.blocked_until === 'string'
        ? value.blocked_until
        : null,
    failureCount: Math.max(0, Number(value.failure_count ?? 0) || 0),
    rejectionCount: Math.max(
      0,
      Number(value.rejection_count ?? 0) || 0,
    ),
    successCount: Math.max(0, Number(value.success_count ?? 0) || 0),
  }
}
