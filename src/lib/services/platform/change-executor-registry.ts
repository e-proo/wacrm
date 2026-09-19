export interface ChangeExecutionContext {
  accountId: string
  changeRequestId: string
  actorUserId: string | null
}

export interface ClaimedChangeExecution {
  id: string
  targetType: string
  targetId: string | null
  intent: string
  proposedPayload: Record<string, unknown>
  expectedVersion: number | null
  contentDigest: string
  claimToken: string
}

export type ChangeExecutionResult = Record<string, unknown>

export class DomainChangeExecutionError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'DomainChangeExecutionError'
    this.code = code
    this.status = status
  }
}

export type ChangeExecutor = (
  context: ChangeExecutionContext,
  change: ClaimedChangeExecution,
) => Promise<ChangeExecutionResult>

export interface ChangeExecutorRegistration {
  actionKey: string
  actionVersion: number
  executor: ChangeExecutor
}

export class ChangeExecutorRegistry {
  private readonly handlers = new Map<string, ChangeExecutor>()

  register(registration: ChangeExecutorRegistration): this {
    if (!registration.actionKey.includes('.')) {
      throw new Error('Change executor action key must be namespaced: ' + registration.actionKey)
    }
    if (!Number.isInteger(registration.actionVersion) || registration.actionVersion < 1) {
      throw new Error('Invalid change executor version: ' + registration.actionKey)
    }

    const id = registration.actionKey + '@' + registration.actionVersion
    if (this.handlers.has(id)) throw new Error('Duplicate change executor: ' + id)
    this.handlers.set(id, registration.executor)
    return this
  }

  has(actionKey: string, actionVersion: number): boolean {
    return this.handlers.has(actionKey + '@' + actionVersion)
  }

  listIds(): readonly string[] {
    return [...this.handlers.keys()]
  }

  async execute(
    actionKey: string,
    actionVersion: number,
    context: ChangeExecutionContext,
    change: ClaimedChangeExecution,
  ): Promise<ChangeExecutionResult> {
    const id = actionKey + '@' + actionVersion
    const executor = this.handlers.get(id)
    if (!executor) throw new Error('CHANGE_EXECUTOR_NOT_REGISTERED:' + id)
    return executor(context, change)
  }
}
