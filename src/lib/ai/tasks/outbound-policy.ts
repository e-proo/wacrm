import type { AgentTaskPolicyReference } from './contracts'

export type AgentTaskOutboundMessageCandidate =
  | {
      kind: 'text'
      text: string
    }
  | {
      kind: 'template'
      templateName: string
      language: string
      params: readonly string[]
    }

export interface AgentTaskOutboundPolicyContext {
  accountId: string
  runId: string
  taskId: string
  taskTargetId: string
  taskType: string
  taskTypeVersion: number
  objective: string
  taskContext: Readonly<Record<string, unknown>>
  targetPolicy: Readonly<Record<string, unknown>>
  counterpartyRole: string
  policy: AgentTaskPolicyReference
  modelCandidateText: string | null
}

export interface AgentTaskOutboundMessagePolicy {
  key: string
  domain: string
  /**
   * Version is audit-only at the platform layer. Long-running behavior is
   * frozen by the task-type version; domains must bump the task type when a
   * message policy changes incompatibly.
   */
  version: number
  prepare(
    context: AgentTaskOutboundPolicyContext,
  ): Promise<AgentTaskOutboundMessageCandidate>
}

const KEY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/

export class AgentTaskOutboundPolicyRegistry {
  private readonly policies = new Map<string, AgentTaskOutboundMessagePolicy>()

  register(
    domainOwner: string,
    policy: AgentTaskOutboundMessagePolicy,
  ): this {
    if (!KEY_RE.test(policy.key)) {
      throw new Error(`Invalid outbound message policy key: ${policy.key}`)
    }
    if (!Number.isInteger(policy.version) || policy.version < 1) {
      throw new Error(
        `Invalid outbound message policy version: ${policy.key}`,
      )
    }
    if (policy.domain !== domainOwner) {
      throw new Error(
        `Outbound policy domain ownership mismatch: ${policy.key} belongs to ${policy.domain}, registered by ${domainOwner}.`,
      )
    }
    if (policy.key.split('.')[0] !== policy.domain) {
      throw new Error(
        `Outbound policy ${policy.key} must use its domain namespace ${policy.domain}.`,
      )
    }
    const id = `${policy.key}@${policy.version}`
    if (this.policies.has(id)) {
      throw new Error(`Duplicate outbound message policy: ${id}`)
    }

    this.policies.set(id, Object.freeze({ ...policy }))
    return this
  }

  get(key: string, version: number): AgentTaskOutboundMessagePolicy | null {
    return this.policies.get(`${key}@${version}`) ?? null
  }

  list(): readonly AgentTaskOutboundMessagePolicy[] {
    return [...this.policies.values()]
  }
}

export function assertValidOutboundMessageCandidate(
  candidate: AgentTaskOutboundMessageCandidate,
): AgentTaskOutboundMessageCandidate {
  if (candidate.kind === 'text') {
    const text = candidate.text.trim()
    if (!text) throw new Error('OUTBOUND_TEXT_EMPTY')
    if (text.length > 4096) throw new Error('OUTBOUND_TEXT_TOO_LONG')
    return { kind: 'text', text }
  }

  const templateName = candidate.templateName.trim()
  const language = candidate.language.trim()
  if (!templateName) throw new Error('OUTBOUND_TEMPLATE_NAME_REQUIRED')
  if (!language) throw new Error('OUTBOUND_TEMPLATE_LANGUAGE_REQUIRED')
  if (candidate.params.length > 100) {
    throw new Error('OUTBOUND_TEMPLATE_PARAMS_TOO_LARGE')
  }

  return {
    kind: 'template',
    templateName,
    language,
    params: candidate.params.map((value) => String(value)),
  }
}
