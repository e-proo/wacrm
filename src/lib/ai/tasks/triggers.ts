import { supabaseAdmin } from '../admin-client'

export type AgentTaskTriggerKind = 'schedule' | 'business_event'
export type AgentTaskScheduleKind = 'once' | 'recurring'

export interface AgentTaskBusinessEventSnapshot {
  id: string
  eventType: string
  eventVersion: number
  subjectType: string
  subjectId: string
  correlationId: string | null
  causationId: string | null
  payload: Readonly<Record<string, unknown>>
  createdAt: string
}

export interface AgentTaskTriggerFiring {
  firingId: string
  accountId: string
  triggerId: string
  taskType: string
  taskTypeVersion: number
  agentId: string
  triggerKind: AgentTaskTriggerKind
  config: Readonly<Record<string, unknown>>
  filters: Readonly<Record<string, unknown>>
  createdBy: string | null
  sourceKey: string
  scheduledFor: string | null
  attempts: number
  businessEvent: AgentTaskBusinessEventSnapshot | null
}

export interface AgentTaskTriggerDefinition {
  accountId: string
  taskType: string
  taskTypeVersion: number
  agentId: string
  triggerKind: AgentTaskTriggerKind
  scheduleKind?: AgentTaskScheduleKind | null
  nextFireAt?: string | null
  intervalMinutes?: number | null
  eventType?: string | null
  eventVersion?: number | null
  config: Readonly<Record<string, unknown>>
  filters?: Readonly<Record<string, unknown>>
  idempotencyKey: string
  createdBy: string | null
}

export interface AgentTaskStartSource {
  triggerType: 'scheduled' | 'business_event'
  triggerRef: string
  sourceKey: string
}

export interface AgentTaskTriggerHandler {
  domain: string
  taskType: string
  taskTypeVersion: number
  validate(definition: AgentTaskTriggerDefinition): void
  start(firing: AgentTaskTriggerFiring): Promise<{ taskId: string }>
}

const TASK_KEY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/

export class AgentTaskTriggerRegistry {
  private readonly handlers = new Map<string, AgentTaskTriggerHandler>()

  register(handler: AgentTaskTriggerHandler): this {
    if (!TASK_KEY_RE.test(handler.taskType)) {
      throw new Error('AGENT_TASK_TRIGGER_HANDLER_TASK_TYPE_INVALID')
    }
    if (!Number.isInteger(handler.taskTypeVersion) || handler.taskTypeVersion < 1) {
      throw new Error('AGENT_TASK_TRIGGER_HANDLER_VERSION_INVALID')
    }
    if (handler.taskType.split('.')[0] !== handler.domain) {
      throw new Error('AGENT_TASK_TRIGGER_HANDLER_DOMAIN_MISMATCH')
    }

    const id = triggerHandlerId(handler.taskType, handler.taskTypeVersion)
    if (this.handlers.has(id)) {
      throw new Error('AGENT_TASK_TRIGGER_HANDLER_DUPLICATE:' + id)
    }
    this.handlers.set(id, Object.freeze({ ...handler }))
    return this
  }

  get(taskType: string, taskTypeVersion: number): AgentTaskTriggerHandler | null {
    return this.handlers.get(triggerHandlerId(taskType, taskTypeVersion)) ?? null
  }

  list(): readonly AgentTaskTriggerHandler[] {
    return [...this.handlers.values()]
  }
}

export function buildAgentTaskTriggerRegistry(
  handlers: readonly AgentTaskTriggerHandler[],
): AgentTaskTriggerRegistry {
  const registry = new AgentTaskTriggerRegistry()
  for (const handler of handlers) registry.register(handler)
  return registry
}

export async function createRegisteredAgentTaskTrigger(input: {
  registry: AgentTaskTriggerRegistry
  definition: AgentTaskTriggerDefinition
}): Promise<string> {
  const handler = input.registry.get(
    input.definition.taskType,
    input.definition.taskTypeVersion,
  )
  if (!handler) {
    throw new Error(
      'AGENT_TASK_TRIGGER_HANDLER_NOT_REGISTERED:' +
        triggerHandlerId(
          input.definition.taskType,
          input.definition.taskTypeVersion,
        ),
    )
  }

  handler.validate(input.definition)

  const filters = input.definition.filters ?? {}
  if (!isRecord(input.definition.config) || !isRecord(filters)) {
    throw new Error('AGENT_TASK_TRIGGER_POLICY_OBJECT_REQUIRED')
  }
  if (
    typeof input.definition.idempotencyKey !== 'string' ||
    input.definition.idempotencyKey.trim().length < 16 ||
    input.definition.idempotencyKey.length > 500
  ) {
    throw new Error('AGENT_TASK_TRIGGER_IDEMPOTENCY_KEY_INVALID')
  }

  const db = supabaseAdmin()
  const { data, error } = await db.rpc('create_agent_task_trigger', {
    p_account_id: input.definition.accountId,
    p_task_type: input.definition.taskType,
    p_task_type_version: input.definition.taskTypeVersion,
    p_agent_id: input.definition.agentId,
    p_trigger_kind: input.definition.triggerKind,
    p_schedule_kind: input.definition.scheduleKind ?? null,
    p_next_fire_at: input.definition.nextFireAt ?? null,
    p_interval_minutes: input.definition.intervalMinutes ?? null,
    p_event_type: input.definition.eventType ?? null,
    p_event_version: input.definition.eventVersion ?? null,
    p_config: input.definition.config,
    p_filters: filters,
    p_idempotency_key: input.definition.idempotencyKey.trim(),
    p_created_by: input.definition.createdBy,
  })
  if (error) throw error
  if (typeof data !== 'string' || !data) {
    throw new Error('AGENT_TASK_TRIGGER_CREATE_FAILED')
  }
  return data
}

export function normalizeAgentTaskTriggerFiring(
  raw: unknown,
): AgentTaskTriggerFiring | null {
  if (!isRecord(raw)) return null

  const firingId = asNonEmptyString(raw.firing_id)
  const accountId = asNonEmptyString(raw.account_id)
  const triggerId = asNonEmptyString(raw.trigger_id)
  const taskType = asNonEmptyString(raw.task_type)
  const agentId = asNonEmptyString(raw.agent_id)
  const sourceKey = asNonEmptyString(raw.source_key)
  const taskTypeVersion = Number(raw.task_type_version)
  const attempts = Number(raw.attempts)
  const triggerKind =
    raw.trigger_kind === 'schedule' || raw.trigger_kind === 'business_event'
      ? raw.trigger_kind
      : null

  if (
    !firingId ||
    !accountId ||
    !triggerId ||
    !taskType ||
    !agentId ||
    !sourceKey ||
    !triggerKind ||
    !Number.isInteger(taskTypeVersion) ||
    taskTypeVersion < 1 ||
    !Number.isInteger(attempts) ||
    attempts < 1
  ) {
    return null
  }

  const businessEvent = normalizeBusinessEvent(raw.business_event)
  if (triggerKind === 'business_event' && !businessEvent) return null
  if (triggerKind === 'schedule' && businessEvent) return null

  return {
    firingId,
    accountId,
    triggerId,
    taskType,
    taskTypeVersion,
    agentId,
    triggerKind,
    config: Object.freeze(isRecord(raw.config) ? { ...raw.config } : {}),
    filters: Object.freeze(isRecord(raw.filters) ? { ...raw.filters } : {}),
    createdBy:
      typeof raw.created_by === 'string' && raw.created_by
        ? raw.created_by
        : null,
    sourceKey,
    scheduledFor:
      typeof raw.scheduled_for === 'string' && raw.scheduled_for
        ? raw.scheduled_for
        : null,
    attempts,
    businessEvent,
  }
}

function normalizeBusinessEvent(
  raw: unknown,
): AgentTaskBusinessEventSnapshot | null {
  if (!isRecord(raw)) return null
  const id = asNonEmptyString(raw.id)
  const eventType = asNonEmptyString(raw.event_type)
  const subjectType = asNonEmptyString(raw.subject_type)
  const subjectId = asNonEmptyString(raw.subject_id)
  const createdAt = asNonEmptyString(raw.created_at)
  const eventVersion = Number(raw.event_version)
  if (
    !id ||
    !eventType ||
    !subjectType ||
    !subjectId ||
    !createdAt ||
    !Number.isInteger(eventVersion) ||
    eventVersion < 1
  ) {
    return null
  }
  return {
    id,
    eventType,
    eventVersion,
    subjectType,
    subjectId,
    correlationId:
      typeof raw.correlation_id === 'string' ? raw.correlation_id : null,
    causationId:
      typeof raw.causation_id === 'string' ? raw.causation_id : null,
    payload: Object.freeze(isRecord(raw.payload) ? { ...raw.payload } : {}),
    createdAt,
  }
}

function triggerHandlerId(taskType: string, version: number): string {
  return taskType + '@' + version
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
