import {
  assertValidAgentTaskTypeManifest,
  type AgentTaskTypeManifest,
} from './contracts'

function taskId(key: string, version: number): string {
  return `${key}@${version}`
}

/**
 * Generic registry for task-type contracts.
 *
 * The caller supplies the domain owner explicitly so registration itself
 * enforces ownership. The registry never switches on concrete task keys such
 * as coverage.sourcing or services.promotion.
 */
export class AgentTaskTypeRegistry {
  private readonly manifests = new Map<string, AgentTaskTypeManifest>()

  register(domainOwner: string, rawManifest: AgentTaskTypeManifest): this {
    const manifest = assertValidAgentTaskTypeManifest(rawManifest)
    if (manifest.domain !== domainOwner) {
      throw new Error(
        `Agent task domain ownership mismatch: ${manifest.key} belongs to ${manifest.domain}, registered by ${domainOwner}.`,
      )
    }

    const id = taskId(manifest.key, manifest.version)
    if (this.manifests.has(id)) {
      throw new Error(`Duplicate agent task type: ${id}`)
    }

    const frozen: AgentTaskTypeManifest = Object.freeze({
      ...manifest,
      requiredAgentCapabilities: Object.freeze([
        ...manifest.requiredAgentCapabilities,
      ]),
      allowedChannels: Object.freeze([...manifest.allowedChannels]),
      allowedTools: Object.freeze(
        manifest.allowedTools.map((tool) => Object.freeze({ ...tool })),
      ),
      followupPolicy: Object.freeze({ ...manifest.followupPolicy }),
      completionPolicy: Object.freeze({
        ...manifest.completionPolicy,
        config: Object.freeze({ ...manifest.completionPolicy.config }),
      }),
      messagePolicy: Object.freeze({
        ...manifest.messagePolicy,
        config: Object.freeze({ ...manifest.messagePolicy.config }),
      }),
    })

    this.manifests.set(id, frozen)
    return this
  }

  get(key: string, version: number): AgentTaskTypeManifest | null {
    return this.manifests.get(taskId(key, version)) ?? null
  }

  has(key: string, version: number): boolean {
    return this.manifests.has(taskId(key, version))
  }

  list(): readonly AgentTaskTypeManifest[] {
    return [...this.manifests.values()]
  }

  listByDomain(domain: string): readonly AgentTaskTypeManifest[] {
    return this.list().filter((manifest) => manifest.domain === domain)
  }
}
