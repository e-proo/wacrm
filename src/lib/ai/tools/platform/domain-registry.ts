import {
  assertValidToolManifest,
  type PlatformToolManifest,
  type PlatformToolPlane,
} from './contracts'

export interface DomainModuleManifest {
  key: string
  version: number
  title: string
  description: string
  capabilities: readonly string[]
  tools: readonly PlatformToolManifest[]
}

export interface FrozenToolGrant {
  toolKey: string
  toolVersion: number
  permission: 'read' | 'propose' | 'execute'
}

export interface ModelToolSelectionContext {
  plane: PlatformToolPlane
  capabilities: readonly string[]
  grants: readonly FrozenToolGrant[]
}

export class DomainRegistry {
  private readonly domains = new Map<string, DomainModuleManifest>()
  private readonly tools = new Map<string, PlatformToolManifest>()

  register(domain: DomainModuleManifest): this {
    if (!/^[a-z][a-z0-9_]*$/.test(domain.key)) throw new Error(`Invalid domain key: ${domain.key}`)
    if (!Number.isInteger(domain.version) || domain.version < 1) throw new Error(`Invalid domain version: ${domain.key}`)
    if (this.domains.has(domain.key)) throw new Error(`Duplicate domain: ${domain.key}`)

    const localKeys = new Set<string>()
    for (const raw of domain.tools) {
      const tool = assertValidToolManifest(raw)
      if (tool.domain !== domain.key) throw new Error(`Tool ${tool.key} belongs to ${tool.domain}, not ${domain.key}`)
      const id = `${tool.key}@${tool.version}`
      if (localKeys.has(id) || this.tools.has(id)) throw new Error(`Duplicate tool contract: ${id}`)
      localKeys.add(id)
    }

    this.domains.set(domain.key, Object.freeze({ ...domain, tools: Object.freeze([...domain.tools]) }))
    for (const tool of domain.tools) this.tools.set(`${tool.key}@${tool.version}`, Object.freeze({ ...tool }))
    return this
  }

  getTool(key: string, version: number): PlatformToolManifest | null {
    return this.tools.get(`${key}@${version}`) ?? null
  }

  listDomains(): readonly DomainModuleManifest[] {
    return [...this.domains.values()]
  }

  listTools(): readonly PlatformToolManifest[] {
    return [...this.tools.values()]
  }

  /**
   * This is only the catalog-selection layer. Runtime policy still performs
   * identity/capability/constraint authorization immediately before invoke.
   */
  modelVisibleTools(ctx: ModelToolSelectionContext): readonly PlatformToolManifest[] {
    const capabilitySet = new Set(ctx.capabilities)
    return ctx.grants.flatMap((grant) => {
      const tool = this.getTool(grant.toolKey, grant.toolVersion)
      if (!tool) return []
      if (!tool.modelExposed || tool.serverOnly) return []
      if (tool.permission !== grant.permission) return []
      if (!tool.allowedPlanes.includes(ctx.plane)) return []
      if (ctx.plane === 'admin' && tool.requiredCapabilities.some((cap) => !capabilitySet.has(cap))) return []
      return [tool]
    })
  }
}

export function defineDomain(domain: DomainModuleManifest): DomainModuleManifest {
  // Validate eagerly so a bad domain fails CI/startup rather than during a chat.
  new DomainRegistry().register(domain)
  return domain
}
